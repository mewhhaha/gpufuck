# GPU functional compiler

This library is a reusable GPU compiler backend for functional languages. You provide parsing and
language-specific desugaring; the library resolves names, infers and checks types on WebGPU, lowers
the program to a numeric core, and emits an ordinary WebAssembly module. The resulting WASM runs
without a GPU or this library.

The portable surface supports strict eager and lazy call-by-need evaluation with signed `i32` and
`i64`, IEEE-754 `f32` and `f64`, Boolean, unit, tuples, higher-order functions, immutable bindings,
recursion, algebraic data, pattern matching, Hindley–Milner inference, indexed constructor results,
and explicitly annotated predicative rank-N parameters. Each frontend chooses the module default and
may override individual bindings or arguments. Read
[Current constraints](#current-constraints-for-a-frontend) before choosing a public entry type.

```text
source → your parser/AST → portable functional module → GPU resolution and typechecking
                                                       ↓
                                           resolved numeric core → WASM bytes → any WASM runtime
```

## Requirements and installation

Compilation requires:

- Deno 2.9 or newer;
- a WebGPU adapter visible to Deno;
- Deno's `webgpu` unstable API enabled.

Add the package to a Deno project:

```sh
deno add jsr:@mewhhaha/gpufuck@^0.1.0
```

Enable WebGPU in `deno.json`:

```json
{
  "unstable": ["webgpu"]
}
```

Import the language-neutral API from `@mewhhaha/gpufuck`. The published entry point does not load
the Lazuli parser or the historical Brainfuck compiler.

The package is prepared for `0.1.0`; the install command becomes available after that version is
published. Until then, clone this repository and map `@mewhhaha/gpufuck` to its `functional.ts` at a
fixed commit.

### Machines without a GPU

There is no CPU semantic-compiler fallback. `requestWebGpuDevice()` throws if WebGPU is disabled or
the host exposes no compatible adapter. A software WebGPU adapter can compile without physical GPU
hardware when the host makes one available, but it is substantially slower and is best treated as a
compatibility path.

This restriction ends at compilation. The emitted `.wasm` is an ordinary WebAssembly module and runs
without WebGPU, this package, or a GPU. A build machine can therefore compile and cache WASM for
CPU-only deployment targets.

To work from a clone and run the repository's checks:

```sh
git clone git@github.com:mewhhaha/gpufuck.git
cd gpufuck
deno task test
```

## Compile a first module to WASM

Save this as `compile.ts`. It constructs `main = 40 + 2`, asks the GPU to infer and compile it,
writes the WASM artifact, and runs the exported `main` function:

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
const encodedModule = buildFunctionalSurfaceModule(
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
  const compilation = await compiler.compileModule(encodedModule);
  if (!compilation.ok) {
    const diagnostic = compilation.diagnostics[0];
    throw new Error(
      `${diagnostic.code} at bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
    );
  }

  try {
    const wasmBytes = await compileFunctionalModuleToWasm(compilation.module);
    await Deno.writeFile("answer.wasm", wasmBytes);

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

```sh
deno run --allow-write=answer.wasm compile.ts
```

`runFunctionalWasmModule(compilation.module)` is the shorter emit, instantiate, run, and decode
path. Use `compileFunctionalModuleToWasm()` when you need to persist, cache, ship, or instantiate
the bytes yourself. If the program needs host values or operations, continue with
[Host capabilities and `Init`](#host-capabilities-and-init).

Emission is memoized for each live `GpuFunctionalModule`. Every public byte array is still an
independent copy, so callers may transfer or mutate it without corrupting later emissions.
`runFunctionalWasmModule()` also reuses the engine-compiled `WebAssembly.Module`, while creating a
fresh instance for every execution so globals, thunks, and the allocation arena never leak between
runs.

Expected compile errors are returned as `FunctionalCompileResult` diagnostics with frontend-neutral
`F` codes and UTF-8 byte spans. WebGPU failures and violated host invariants throw. A successful
`GpuFunctionalModule` owns GPU buffers and must be destroyed; emitted WASM bytes remain valid after
that destruction.

### Failure model

The public API separates source-program failures from invalid calls and infrastructure failures:

| Boundary                                                        | Failure channel                                       | Structured evidence                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `compileModule()` and `compileBatch()`                          | `{ ok: false, diagnostics }`                          | `F1xxx`/`F2xxx`, UTF-8 span, and related declaration spans                         |
| `GpuFunctionalEvaluator` and Type Core execution                | `{ ok: false, fault }`                                | `F3001`–`F3012`, fault kind, source offset, and execution statistics               |
| required compile-time execution                                 | compile result, runtime fault, or comptime diagnostic | `F1xxx`/`F2xxx`, `F3xxx`, or `F5001`–`F5002` with the responsible export and limit |
| `linkFunctionalModules()`                                       | throws `FunctionalLinkError`                          | `F4001`–`F4007`, fault kind, module, and referenced import or export               |
| WASM arguments and `init`                                       | throws `FunctionalWasmBoundaryError`                  | `F4101`/`F4102`, fault kind, and field path                                        |
| `runFunctionalWasmModule()` and its async variant               | throws `FunctionalWasmRuntimeError`                   | runtime code, entry name, core node, source span, and original cause               |
| WebGPU discovery, cancellation, or violated internal invariants | rejects or throws                                     | actionable message with the original cause where one exists                        |

Malformed encoded IR and invalid numeric options throw before GPU submission because they are API
contract violations, not source-language diagnostics. Cancellation rejects with the caller's abort
reason. A host operation failure is wrapped as `F3101` with its capability and operation while
retaining the host exception in `cause`; division by zero, blackholes, allocation failure, result
limits, cyclic results, replay divergence, and suspension limits likewise have distinct runtime
kinds.

The typed translation belongs to the library runners. Code that instantiates emitted bytes directly
receives native `WebAssembly.RuntimeError` traps; generated modules export `runtimeFault` and
`runtimeFaultNode` globals so another runtime adapter can perform the same translation.

`FunctionalDiagnostic.related` points to declarations involved in conflicts. Linked modules retain
their source ranges on the compiled module, so runtime faults are remapped automatically.
`locateFunctionalDiagnostic(linked.sources, diagnostic)` performs the same remapping for compile
diagnostics. Frontends remain responsible for converting module-relative UTF-8 byte spans into
filenames, lines, columns, and source-language wording.

## Connect your language frontend

Your frontend should perform syntax-specific work and stop at the functional surface:

1. Parse source into your AST and enforce source-language scoping rules that differ from the core.
2. Desugar language conveniences into unary functions, immutable bindings, applications,
   conditionals, constructors, and cases.
3. Choose `StrictEager` or `LazyCallByNeed` as the module's default evaluation profile.
4. Convert source type declarations and optional annotations into `FunctionalTypeSchema` values.
5. Call `buildFunctionalSurfaceModule()` or encode the ABI tables directly.
6. Reuse one `GpuFunctionalCompiler` to compile modules, then emit WASM.

The surface builder interns symbols, curries `parameters`, appends the reserved unit and pair types,
and packs the flat ABI. A small expression lowering typically looks like this:

```ts
import {
  FunctionalBinaryOperator,
  type FunctionalSurfaceExpression,
  surface,
} from "@mewhhaha/gpufuck";

type SourceExpression =
  | { kind: "integer"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "lambda"; parameter: string; body: SourceExpression }
  | { kind: "call"; callee: SourceExpression; arguments: readonly SourceExpression[] }
  | { kind: "add"; left: SourceExpression; right: SourceExpression };

function lowerExpression(expression: SourceExpression): FunctionalSurfaceExpression {
  switch (expression.kind) {
    case "integer":
      return surface.integer(expression.value);
    case "variable":
      return surface.name(expression.name);
    case "lambda":
      return surface.lambda(expression.parameter, lowerExpression(expression.body));
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

Attach `{ startByte, endByte }` spans from the original source to definitions, declarations, and
expressions. Offsets are UTF-8 bytes, not JavaScript string indices. These spans are the evidence
reported by GPU diagnostics.

`buildFunctionalSurfaceModule()` defaults to `FunctionalEvaluationProfile.StrictEager`, so a strict
frontend gets eager local bindings, function arguments, and constructor fields without a separate
forcing pass. Haskell-like frontends select `LazyCallByNeed`. A mixed frontend can set
`valueEvaluation` on a `let` expression or `argumentEvaluation` on an `apply` expression; those
resolved choices are stored in Core and observed identically by the GPU evaluator and WASM backend.
These fields control evaluation at binding boundaries. A first-class, explicitly typed `Thunk<T>`
value is not part of the current surface.

### Source-feature mapping

| Source-language construct | Functional surface lowering                                          |
| ------------------------- | -------------------------------------------------------------------- |
| Multiple parameters       | `parameters` or nested unary lambdas                                 |
| Function call             | Left-associated unary `apply` nodes                                  |
| Tuple `(a, b)`            | Apply `FUNCTIONAL_PAIR_CONSTRUCTOR_NAME` to `a`, then `b`            |
| Unit                      | `FUNCTIONAL_UNIT_CONSTRUCTOR_NAME`                                   |
| Struct or variant         | A nominal type declaration plus constructor applications             |
| Pattern match             | `case` with flat constructor binders; nest cases for nested patterns |
| Local binding             | `let`                                                                |
| Local recursive function  | `let-rec` whose value is a lambda                                    |
| Module or record          | A generated immutable algebraic type, or a linked module artifact    |
| Typeclass or trait        | Resolve statically or pass an explicit dictionary value              |
| Effect                    | Lower to Effect Core or an explicit host capability                  |

Names in the portable module are deliberately unresolved. The GPU resolves lexical locals, global
definitions, constructors, dependencies, recursive SCCs, annotations, and case coverage. Your
frontend should still reject constructs whose meaning belongs to its language—for example OCaml
forward references or Rust mutation—before building the module.

### Algebraic data and annotations

Declare nominal data with `FunctionalSurfaceTypeDeclaration`. Constructor fields have structural
schemas and may optionally declare an indexed result:

```ts
const optionType = {
  name: "Option",
  parameters: ["value"],
  constructors: [
    { name: "None", fields: [] },
    {
      name: "Some",
      fields: [{
        name: "value",
        type: { kind: "parameter", name: "value" },
      }],
    },
  ],
} as const;
```

Pass declarations such as `optionType` in the second argument to `buildFunctionalSurfaceModule()`.
Constructors are ordinary curried values in expressions, so `Some 42` lowers to
`surface.apply(surface.name("Some"), surface.integer(42))`.

Leave `definition.annotation` as `null` for ordinary inference. Use a `FunctionalTypeSchema` when a
higher-rank boundary or a non-principal indexed contract needs an explicit choice. Type parameters
are names local to their schema or declaration; the builder converts them to canonical metadata.

### Compile many modules

`compileBatch()` packs independent modules into GPU lanes and preserves input order:

```ts
const results = await compiler.compileBatch(encodedModules);
for (const result of results) {
  if (!result.ok) {
    console.error(result.diagnostics);
    continue;
  }
  try {
    const wasmBytes = await compileFunctionalModuleToWasm(result.module);
    // Cache or publish wasmBytes.
  } finally {
    result.module.destroy();
  }
}
```

Create the device and compiler once per worker or service lifetime. Batch independent requests when
latency permits; do not create a device for each source file. Compilation options provide total
fuel, dispatch-quantum, and cancellation bounds.

## Current constraints for a frontend

- Strict eager and lazy call-by-need bindings and applications may be mixed in one module. A
  first-class `Thunk<T>` value and arbitrary `delay`/`force` expressions are not implemented.
- Direct WASM execution accepts and returns concrete first-order values. Scalars use native WASM
  values; tuples and nominal constructors use the versioned `FunctionalWasmValueAbi` memory layout.
  Higher-order functions remain internal and cannot cross the public WASM boundary.
- Primitive numeric profiles include wrapping signed `i32`, signed `i64`, IEEE-754 `f32`, and
  IEEE-754 `f64`, with typed comparisons, arithmetic, signed remainder, integer bit operations and
  shifts, `f32` square root, numeric conversions, and `i32`/`f32` bit reinterpretation. A frontend
  still owns numeric-class defaulting and its source language's overflow policy. Raw memory
  intrinsics and native `v128` operations are not functional-core primitives.
- The graph evaluator executes `i32`, two-word software `i64`, and exactly representable basic `f32`
  operations on the GPU. `f64`, `f32` division, and `f32` square root use separately cached,
  fuel-instrumented WASM because portable WGSL does not provide `i64`/`f64` and may relax division
  rounding. GPU dispatch, heap, and stack controls apply only to the GPU path; the WASM path accepts
  the common semantic fuel bound.
- Mutation, exceptions, source layout, FFI, and garbage collection are not implicit backend
  services. Ownership is explicit at the host boundary, and frontends still prove borrow and move
  correctness before selecting those contracts.
- Semantic compilation requires WebGPU. The emitted WASM does not.

See [Deliberate limits](#deliberate-limits) for exact structural and runtime bounds.

### Numeric and structured WASM entries

The surface has distinct operators for each numeric representation; it never guesses a conversion.
For example, this entry accepts an `i64` and returns `(i64, f64)`:

```ts
const i64 = { kind: "signed-integer-64" } as const;
const module = buildFunctionalSurfaceModule(
  [{
    name: "main",
    parameters: ["input"],
    annotation: {
      kind: "function",
      parameter: i64,
      result: { kind: "tuple", values: [i64, { kind: "float-64" }] },
    },
    body: surface.apply(
      surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
      surface.binary(
        FunctionalBinaryOperator.AddSignedInteger64,
        surface.name("input"),
        surface.signedInteger64(1n),
      ),
      surface.convert(
        FunctionalNumericConversion.SignedInteger64ToFloat64,
        surface.name("input"),
      ),
    ),
  }],
  [],
  "main",
  0,
);

const compilation = await compiler.compileModule(module);
if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
try {
  const execution = await runFunctionalWasmModule(compilation.module, {
    argument: { kind: "signed-integer-64", value: 9_007_199_254_740_992n },
  });
  console.log(execution.value);
} finally {
  compilation.module.destroy();
}
```

`runFunctionalWasmModule()` initializes the runtime arena, encodes the argument, calls `main`,
forces structured fields as they are decoded, and stops after `maximumResultNodes` values. Indexed
constructors are decoded against their declared result refinement, so a field such as `Vector n`
uses the `n` selected by the actual constructor rather than the outer declaration parameter.

Consumers that instantiate emitted bytes themselves can use `FunctionalWasmValueAbi` instead of
depending on private code-generator details. ABI v1 uses eight-byte values and aligned objects with
this public header:

| Byte offset | Width | Meaning                                                |
| ----------- | ----- | ------------------------------------------------------ |
| 0           | 4     | Object kind                                            |
| 4           | 4     | Constructor index, state, numeric kind, or resource ID |
| 8           | 4     | Field count or byte length                             |
| 12          | 4     | Reserved                                               |
| 16          | ...   | Contiguous values or bytes                             |

Arena-backed modules export `initialize()` for argument allocation and `forceValue(i64) -> i64` for
possibly lazy fields. Scalar entry parameters and results use native WASM values; structured values
use the shared `i64` value representation. Higher-order values are deliberately excluded from this
boundary.

`FunctionalHostTypes` adds UTF-8 text, bytes, typed arrays, typed slices, and nominal resource
handles to that boundary. Arena-backed modules export `allocate`, `free`, `heapTop`, and
`freeListHead`; transferred arguments are released into a reusable free list, while
`markFunctionalWasmScratch()` and `resetFunctionalWasmScratch()` provide explicit region cleanup.
Host fields can declare bounded-borrow, frozen-shareable, ownership-transfer, and unique contracts.

Use `wasmExports` in `FunctionalSurfaceModuleOptions` to publish additional annotated definitions as
independent persistent WASM callables. `main` remains the selected whole-program entry. Callable
integer parameters retain the stable tagged-`i64` boundary representation and integer results are
native `i32`. A strict, effect-free, captureless integer callable is lowered to a direct native
worker: each argument is decoded once, and the call does not initialize globals, allocate a closure,
or use indirect dispatch. Lazy, higher-order, aggregate, effectful, and captured callables retain
the general value ABI.

Suspending operations execute with `runFunctionalWasmModuleAsync()`. The runner memoizes completed
host calls, unwinds at an unresolved Promise, awaits it, and resumes by deterministic replay without
repeating already completed effects. `maximumSuspensions` bounds that protocol. The ordinary direct
runner remains synchronous and rejects a module that declares suspending operations.

### Link separately prepared modules

`createFunctionalModuleArtifact()` validates one frontend module's definitions, nominal types, typed
imports, and typed exports without introducing source-language module semantics. Link artifacts with
`linkFunctionalModules()` before GPU compilation:

```ts
const linked = linkFunctionalModules([libraryArtifact, applicationArtifact], {
  module: "application",
  exportName: "main",
});
const result = await compiler.compileModule(linked.module);
```

Every definition, type, and constructor receives a module-qualified core name. Import aliases become
annotated boundary definitions, so the GPU checks the importing module's declared contract against
the exported implementation. `linked.sources` maps aggregate UTF-8 byte offsets back to the
originating module. This is link-before-GPU whole-program compilation; independently emitted WASM
object files and dynamic WASM linking are not part of this artifact format.

Nominal types referenced by an import are resolved from its source module. An importing module may
refer to `Box` when that name is unambiguous or use `library::Box` explicitly. Linked constructor
names are likewise qualified in decoded WASM values, which prevents unrelated modules from silently
sharing a nominal type.

### Recompile changed modules incrementally

Use `IncrementalGpuFunctionalCompiler` when a frontend retains module artifacts across builds. It
fingerprints each module's exported interface separately from its implementation, compiles changed
dependency SCCs in one GPU batch, and relinks cached resolved Core by symbolic definition and
constructor names:

```ts
import {
  compileFunctionalModuleToWasm,
  DirectoryFunctionalIncrementalCache,
  GpuFunctionalCompiler,
  IncrementalGpuFunctionalCompiler,
} from "@mewhhaha/gpufuck";

const compiler = await GpuFunctionalCompiler.create(device);
const incremental = new IncrementalGpuFunctionalCompiler(compiler, {
  cache: new DirectoryFunctionalIncrementalCache(".gpufuck-cache"),
  // Change this when the frontend's lowering rules or private IR ABI change.
  compilerVersion: "my-language-frontend@3",
});
const result = await incremental.compile(
  [libraryArtifact, applicationArtifact],
  { module: "application", exportName: "main" },
);
if (!result.ok) {
  console.error(result.diagnostics);
} else {
  try {
    console.log(result.incremental.compiledModules);
    const wasmBytes = await compileFunctionalModuleToWasm(result.module);
    // Store or instantiate wasmBytes.
  } finally {
    result.module.destroy();
  }
}
```

Changing only a module body invalidates that module's SCC. Importers reuse their typechecked Core as
long as every imported interface is unchanged. Changing an exported type, nominal declaration,
effect/capability boundary, evaluation profile, or WASM export invalidates reverse dependencies.
Mutually recursive modules are always compiled and cached as one unit. All cache keys also include
the Functional ABI, cache format, target, and compiler/frontend version.

`MemoryFunctionalIncrementalCache` is useful for a watch process. The directory cache survives
processes and requires Deno read/write permission for its directory. Cache entries contain portable
resolved Core and inferred entry types, never live `GPUBuffer` objects. WASM emission still performs
whole-program capture analysis and specialization after relinking, so cached modules do not prevent
cross-module optimization. The ordinary `linkFunctionalModules()` plus `compileModule()` path
remains a whole-program compilation, and the portable cache is not a dynamic-linking or public WASM
object-file format.

### Evaluate required constants at compile time

`GpuFunctionalComptimeExecutor` is the target-neutral staging boundary for frontends that have a
`comptime`, `consteval`, type-reflection, or required-constant construct. A comptime artifact uses
the same definitions, nominal types, imports, exports, and evaluation profiles as an ordinary
Functional module, but it deliberately has no host capabilities or effects. Its selected exports
must evaluate to closed first-order constants.

```ts
import {
  FunctionalBinaryOperator,
  type FunctionalComptimeModuleArtifact,
  GpuFunctionalComptimeExecutor,
  requestWebGpuDevice,
  surface,
} from "@mewhhaha/gpufuck";

const constants: FunctionalComptimeModuleArtifact = {
  name: "configuration",
  definitions: [{
    name: "bufferSize",
    parameters: [],
    annotation: { kind: "integer" },
    body: surface.binary(
      FunctionalBinaryOperator.Multiply,
      surface.integer(64),
      surface.integer(1024),
    ),
  }],
  typeDeclarations: [],
  imports: [],
  exports: [{
    name: "bufferSize",
    definition: "bufferSize",
    type: { kind: "integer" },
  }],
  sourceByteLength: 24,
};

const device = await requestWebGpuDevice();
try {
  const executor = await GpuFunctionalComptimeExecutor.create(device);
  const result = await executor.execute([constants], {
    maximumCompilationSteps: 100_000,
    maximumExecutionSteps: 100_000,
    maximumOutputBytes: 64 * 1024,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  console.log(result.exports[0]?.value); // { kind: "integer", value: 65536 }
} finally {
  device.destroy();
}
```

An exported single-argument comptime function can be compiled once and invoked repeatedly. Use a
tuple when the metaprogram has several logical arguments. Each call is bounded independently, and a
bounded in-process LRU memoizes successful calls by the resolved-Core fingerprint, encoded constant
argument, and execution-fuel policy:

```ts
const specializer: FunctionalComptimeModuleArtifact = {
  name: "specializer",
  definitions: [{
    name: "specialize",
    parameters: ["value"],
    annotation: {
      kind: "function",
      parameter: { kind: "integer" },
      result: { kind: "integer" },
    },
    body: surface.binary(
      FunctionalBinaryOperator.Multiply,
      surface.name("value"),
      surface.integer(2),
    ),
  }],
  typeDeclarations: [],
  imports: [],
  exports: [{
    name: "specialize",
    definition: "specialize",
    type: {
      kind: "function",
      parameter: { kind: "integer" },
      result: { kind: "integer" },
    },
  }],
  sourceByteLength: 32,
};
const compilation = await executor.compileFunction(
  [specializer],
  { module: "specializer", exportName: "specialize" },
);
if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
try {
  const result = await compilation.compiledFunction.invoke(
    { kind: "integer", value: 64 },
    { maximumExecutionSteps: 100_000 },
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
  console.log(result.value, result.stats.memoized);
} finally {
  compilation.compiledFunction.destroy();
}
```

The result remains an ordinary typed `FunctionalConstant`. Scalar and aggregate constants are
values; `FUNCTIONAL_COMPTIME_DESCRIPTOR_SCHEMA` carries type trees; frontend-declared ADTs carry
proofs and capability evidence. Because those distinctions are represented by the metaprogram's
checked result type rather than by privileged host tags, a frontend can define richer evidence
without extending gpufuck.

Code generation uses the canonical `FUNCTIONAL_COMPTIME_IR_TYPES` ADTs. A metaprogram returns a
`FUNCTIONAL_COMPTIME_IR_SCHEMA` definition list, the host decodes it with
`functionalGeneratedDefinitionsFromConstant()`, and `spliceFunctionalGeneratedDefinitions()` adds
the inferred definitions to a normal module artifact. The decoder rejects malformed constructors,
UTF-8 names, operator identifiers, evaluation profiles, and list shapes before the generated code
reaches the compiler. Linking, resolution, inference, diagnostics, and Wasm emission then follow the
same path as handwritten Functional IR. Generated fragments currently contain definitions and
expressions; imports, exports, nominal declarations, and annotations remain explicit host artifact
metadata.

```sh
deno task run:comptime-codegen
```

Required execution supports pure functions, bounded recursion, all Functional scalar types, tuples,
ADTs, cases, and constants imported across modules. Compiler fuel, semantic execution fuel, output
nodes, output bytes, and output depth are bounded on every path. Closed first-order constants
execute through fuel-instrumented WASM by default; the GPU still performs resolution and inference.
Passing `maximumStepsPerDispatch`, `heapSlots`, or `stackFrames` explicitly selects GPU evaluation
for deterministic dispatch and workspace testing. Outputs containing functions also use the GPU so
they can be reported as `F5001` rather than failing at the first-order WASM boundary. Exhausting a
compiler or evaluator budget returns that subsystem's structured diagnostic or fault; an invalid
float-to-integer conversion returns `F3012`, while a closure or oversized result returns `F5001` or
`F5002`.

The canonical `FunctionalConstant` ABI represents `i64`, `f32`, and `f64`, including NaN,
infinities, and negative zero. GPU `i64` arithmetic wraps to two's-complement 64-bit results. The
default instrumented WASM path charges deterministic semantic steps, including recursive calls.
Generated instrumented modules are retained in a bounded cache keyed by the resolved Core and its
code-generation metadata, so equivalent recompilations reuse the same executable artifact without
retaining GPU buffers. An `AbortSignal` is observed between GPU dispatches and before and after
synchronous WASM execution; it cannot interrupt the engine while one WASM call is on the stack.

Use `IncrementalGpuFunctionalComptimeExecutor` with a memory or directory incremental cache for
cross-module constants. Cache entries are keyed by implementation and dependency output. If a
dependency's implementation changes but computes the same exported constants, its consumers remain
valid; a changed constant invalidates the reverse dependency closure. Mutually recursive modules
remain one cache unit.

Use `deno task bench:functional-comptime` to compare default bounded-WASM execution, explicit GPU
evaluation, packed batches, and unchanged incremental cache hits on the active machine. Tiny scalar
constants are intentionally a WASM workload: GPU submission and readback latency is larger than the
computation, while the GPU compiler continues to amortize well across wide source batches.

Type Core results can cross the same staging boundary without a second reflection runtime.
`functionalConstantFromTypeCoreValue()` converts a Type Core integer, Boolean, symbol, or type tree
to ordinary descriptor ADTs declared by `FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPES`. A frontend may add
those declarations to a comptime artifact and inspect them with normal constructors and cases.

`partiallyEvaluateFunctionalModule()` is the optional optimization form. It attempts exported or
annotated nullary definitions and replaces successful pure results with literal Functional
expressions. Compile errors, runtime faults, closures, and limits leave the original artifact
unchanged, so this optimization never decides whether a valid runtime program compiles.

## Learn from the included frontends

The repository contains independent frontends that all target the same public surface. They are
integration examples, not compatibility claims for their source languages.

| Frontend                                         | What it demonstrates                                                                             | Run an example                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [Rust](examples/rust-functional/)                | Enums, structs, generics, matches, and source-level rejection of mutation                        | `deno task run:rust-functional examples/rust-functional/option_map.rs`        |
| [Haskell](examples/haskell-functional/README.md) | Laziness, inferred polymorphism, higher-order functions, dictionaries, GADTs, and recursive data | `deno task run:haskell-functional examples/haskell-functional/combinators.hs` |
| [OCaml](examples/ocaml-functional/README.md)     | Sequential scope, explicit recursion, variants, lists, and frontend desugaring                   | `deno task run:ocaml-functional examples/ocaml-functional/tree.ml`            |
| [1SubML](examples/onesubml-functional/README.md) | Rank-N parameters, records as modules, and expression blocks                                     | `deno task run:onesubml-functional examples/onesubml-functional/rank3.ml`     |
| [Lazuli](examples/lazuli/)                       | The full reference syntax, indexed proofs, host values, and lazy evaluation                      | `deno task run:lazuli examples/lazuli/list.laz`                               |

Each frontend has a `trace` task that writes source, normalized surface, encoded ABI, and
GPU-resolved core side by side. For example:

```sh
deno task trace:haskell-functional \
  examples/haskell-functional/tree.hs \
  examples/haskell-functional/tree.trace.md
```

The smallest backend-only examples live in [`examples/functional-ir`](examples/functional-ir/). They
cover type programming, effects, Effect Core, and host `Init` without involving Lazuli.

## Frontend contract reference

A functional-language frontend should need to provide only a versioned module with:

- a flat expression graph built from variables, immutable bindings, recursion, lambdas, application,
  conditionals, primitive operations, constructors, and case arms;
- interned symbols, definitions, algebraic type declarations, constructor fields, annotations, and
  optional indexed constructor results;
- structural type schemas for annotations, parameters, constructor fields, and indexed results;
- an explicit entry definition, evaluation profile, typechecking profile, and primitive capability
  table;
- source byte spans for diagnostics;
- explicit counts and limits so the GPU can validate every range before semantic work begins.

This encoded module is the portable high-level IR: it is smaller than a frontend AST but still
retains names, type schemas, and source evidence. The GPU resolves it into the lower core IR
consumed by inference and evaluation.

Frontend-specific syntax is desugared before this boundary. Lists, text literals, records,
multi-argument functions, modules, traits, or other language features can target the smaller
functional core rather than requiring syntax-specific shader paths. A frontend may perform parsing
and structural packing, but production name resolution, dependency analysis, type inference,
coverage checking, and core lowering belong to the GPU backend.

Language neutrality also applies to semantics. The current implementation provides strict eager and
lazy call-by-need evaluation alongside Hindley–Milner-plus-indexed-types and predicative-rank-N
profiles. Explicit annotations may place `forall` at recursively nested function-parameter
boundaries. Actual schemes are instantiated, expected schemes are skolemized, and function
parameters are compared contravariantly while results are compared covariantly. Impredicative
quantifiers remain unsupported. A language with its own type system should be able to submit a
pretyped module for GPU verification instead of being forced through inference. Effects and module
systems can be lowered into explicit core values and operations rather than becoming parser-specific
backend branches.

The functional API does not assume Lazuli keywords, its Baba parser, or its source diagnostic
prefix. Likewise, the Brainfuck instruction format is not a backend IR. ABI v5 accepts
`strict-eager-v1` and `lazy-call-by-need-v1` evaluation profiles with either
`hindley-milner-indexed-v1` or `predicative-rank-n-indexed-v1` typechecking; profile metadata
prevents a rank-1 module from silently acquiring first-class polymorphic parameters.

## Optional frontend services

The basic frontend path needs only the surface builder and `GpuFunctionalCompiler`. The following
APIs are optional stages for languages that want compile-time type execution, capability evidence,
or checked effects.

### Compile-time Type Core

Frontends that need type-level computation can target the parser-independent `TypeCoreProgram` API.
It is a small, pure, kinded language rather than an extension of Lazuli syntax. Its closed values
have four kinds: `type`, wrapping `i32`, Boolean, and interned symbol. Type values compose
primitive, named, tuple, and function types; named type constructors may mix parameters of all four
kinds.

Type functions support calls, conditionals, structural matching, wrapping `i32` arithmetic, and
symbol equality. Recursion is allowed but never assumed to terminate: the same GPU abstract machine
used by the functional backend evaluates it with explicit fuel, heap, stack, result-size, dispatch,
and cancellation bounds. Before upload, the host verifies kinds and performs structural lowering;
the GPU compiler then checks the lowered representation and the GPU evaluator computes the closed
result. The decoded result is immutable and checked against the entry kind.

Programs are structurally bounded to depth 512 and width 256 for constructor parameters, function
parameters, and match arms. Those limits keep host lowering and the current functional ABI within
predictable graph depth; runtime fuel and memory options bound dynamic expansion separately.

```ts
import { GpuTypeCoreExecutor, requestWebGpuDevice } from "./functional.ts";

const device = await requestWebGpuDevice();
const types = await GpuTypeCoreExecutor.create(device);
const result = await types.execute({
  typeConstructors: [{ name: "Vector", parameterKinds: ["type", "integer"] }],
  functions: [],
  entry: {
    kind: "type",
    type: {
      kind: "named",
      name: "Vector",
      arguments: [
        { kind: "type", type: { kind: "integer" } },
        { kind: "integer", value: 42 },
      ],
    },
  },
});
device.destroy();
```

Use `executeBatch()` for independent compile-time programs. It preserves input order and packs both
semantic compilation and evaluation into shared GPU submissions while retaining lane-local fuel,
faults, and decoded values:

```ts
const results = await types.executeBatch(typePrograms);
```

Repeated references to the same immutable `TypeCoreProgram` are coalesced within one batch and
decoded independently at every result position. Structurally equal but separately allocated program
objects remain distinct lanes.

On the benchmark machine, 32 distinct matrix programs complete in about 45.2 ms total, or 1.41 ms
per program, while one scalar execution takes about 36.3 ms. The larger reflection workload
completes in 92.5 ms, or 2.89 ms per program. Repeating one matrix program object 32 times takes
37.7 ms total because only one lane is evaluated. Batching improves throughput rather than the
latency of a single dependent type computation.

Capability discovery is deliberately separate from deterministic type execution.
`TypeCoreCapabilityResolver` indexes declarative rules by predicate, matches kinded structural
patterns, resolves prerequisites, and returns associated outputs plus an evidence tree. Witnesses
state whether a proof is erased, names a compile-time implementation, or requires a runtime
dictionary. `verify()` independently replays the rule tree, so cached or transported evidence need
not be trusted. Search has explicit transition and depth limits, reports overlap as ambiguity, and
requires every output and prerequisite variable to be determined by the rule inputs. Typical
predicates can describe `field(owner, name) -> fieldType`, `method(owner, name) -> implementation`,
or ordinary propositions such as `copy(type)`.

#### Higher-kinded normalization and associated families

`FunctionalTypeNormalizer` is the specialization stage between a richer frontend type language and
the deliberately first-order GPU schema ABI. Type functions may accept constructor-kinded parameters
such as `(type -> type)` and apply them during bounded compile-time normalization. A fully applied
nominal constructor becomes the ordinary `named` schema already consumed by GPU inference; an
unsaturated constructor never crosses the ABI boundary.

Associated expressions ask the capability resolver for a named output. This gives families the same
independently verifiable evidence, ambiguity detection, cycle detection, and bounded search as
facts, fields, and methods. The normalization result retains every selected evidence tree. Recursive
type-function reduction has its own transition limit.

```sh
deno run examples/functional-ir/type_program.ts
```

The example normalizes `Twice List Int` to `List (List Int)` and resolves `element (List Int)` to
`Int`. First-order type functions that need value-level arithmetic or matching can still execute on
the GPU through `GpuTypeCoreExecutor`; higher-kinded specialization erases constructor parameters
before producing that first-order input.

#### Idris2-style indices and Zig-style comptime

The [type-programming profile examples](examples/type-programming/README.md) exercise two richer
frontend mappings. The Idris2-style example reduces Peano addition to compute `Vect 3 Int`, converts
that closed Type Core result through `functionalSchemaFromTypeCoreType()`, and then asks ordinary
GPU inference to verify a three-element indexed vector. Constructor field parameters may occur
anywhere structurally in an indexed result; only parameters absent from the result remain
existential and are rejected.

The first Zig-style example constructs `Array 6 (Array 7 i32)` from mixed-kinded `comptime`
parameters and computes the cell count `42`. The reflection example represents synthesized fields
and attached methods as recursive Type Core metadata. GPU execution walks the fields, finds a method
by symbol, and erases the selected implementation to a statically checked functional call. Both
pipelines emit WebAssembly that returns `42`, while the checked-in Zig sources independently pass
`zig test`.

```sh
deno task run:idris2-type-programming
deno task run:zig-comptime
deno task run:zig-reflection
deno task compare:type-programming
```

These are semantic lowering profiles, not complete syntax frontends. Idris2 still needs elaboration,
`Pi` types, universes, implicit search, and totality checking. Zig still needs compile-time memory,
imperative loops, exact aggregate layout, explicit compile errors, and general specialized term
generation. Type Core values with non-type indices must be erased or converted to generated nominal
runtime types before entering the functional schema ABI. The timing task reports GPU startup and
steady-state latency, fresh-cache Zig compilation, and 32-program results. Its output states the
phase and batching differences.

### Algebraic effects

`GpuFunctionalCompiler.compileEffectModule()` accepts a portable Effect Core built from `return`,
`host-call`, `perform`, `bind`, `branch`, and `handle`. A separate persistent GPU pass validates one
computation record per transition. Its bottom-up phase checks canonical first-order operation types
and branch results while inferring the operation row; its linear phase requires the root to have no
parent and every other computation exactly one. Reused or cyclic computation records therefore fail
before lowering.

Handlers are ordinary `parameter -> result` functions. The shared lowering creates their
continuations, so user code cannot discard or invoke a resumption twice. Unhandled local operations
are rejected. Effectful host calls and handled operations lower through a strict, shared
continuation; pure host calls remain ordinary expressions governed by the frontend's chosen
evaluation modes. The resulting surface then goes through the existing GPU name resolver and
Hindley–Milner inferencer, which independently checks the actual embedded value expressions against
the Effect Core annotations.

Effect Core keeps `LazyCallByNeed` as its compatibility default and accepts an optional
`evaluationProfile` when a frontend wants strict pure calls and bindings. Effectful operations stay
explicitly sequenced under either profile.

Effect verification and ordinary semantic compilation share the caller's fuel budget.
`maximumStepsPerDispatch` bounds both stages, cancellation is observed between GPU submissions, and
`GpuFunctionalModule.entryEffects` records the host requirements remaining at the executable
boundary. The internal verifier exposes dispatch observations only to deterministic tests.

```sh
deno run --allow-read examples/functional-ir/effects.ts
deno run --allow-read examples/functional-ir/effect_core.ts
```

`lowerFunctionalEffectProgram()` remains as a small host-only lowering utility. New frontends should
prefer Effect Core when they need GPU-verified rows, linear sequencing, fuel, or cancellation.
Handled algebraic effects stay inside the compiled module. Operations that escape to the host use
the `Init` capability boundary below. A host operation may declare `execution: "suspending"` so a
frontend can retain an explicit async-resumption boundary; direct WASM emission rejects that
boundary with its capability name because the current executable protocol is synchronous.

### Host capabilities and `Init`

A frontend may declare immutable host values and synchronous host operations in
`buildFunctionalSurfaceModule(..., { hostCapabilities })`. The builder adds one reserved
`$FunctionalInitType` constructor whose fields carry those values and operation closures. The entry
definition then has the ordinary inferred type `$FunctionalInitType -> result`; it destructures the
constructor with the same `case` nodes used for any other algebraic value. The GPU therefore checks
every use of a host field without needing host-specific inference rules or core opcodes.

`runFunctionalWasmModule(module, { init })` validates the supplied capability and field names before
instantiation. Immutable values are read once while constructing `Init`. Operations become direct
WASM imports under `functional_init:<capability>` and receive and return the same values accepted by
`runFunctionalWasmModule()`. A Text or Bytes value may instead provide `wasmLiteral`, and a pure
synchronous operation may select a `FunctionalWasmIntrinsic` for byte length, indexing, slicing,
append, equality, or Text/Bytes conversion. Those fields are allocated or executed entirely inside
the emitted module and require no JavaScript `init` binding or WASM import. The host ABI supports
`i32`, `i64`, `f32`, `f64`, boolean, unit, tuple, and nominal constructor fields and operations. It
wraps host exceptions with the capability and operation name while preserving the original exception
as `cause`.

Purity is a frontend contract recorded on each operation as `pure` or `effectful`; the backend never
guesses it from a JavaScript implementation. The language decides which operations are effects and
what its `IO` abstraction means. Effect Core owns the shared sequencing mechanism, so strict and
lazy frontends do not need separate token-threading implementations. Pure languages can expose only
pure operations, while a frontend without effect analysis can conservatively label every host
operation effectful.

```sh
deno run --allow-read examples/functional-ir/host_init.ts
```

The current evaluator is a bounded graph reducer with strict and call-by-need binding modes, not an
interaction-net implementation. The public Type Core and evidence formats keep that implementation
choice internal: a future local interaction reducer can replace the lowering without making frontend
IRs depend on ports, agents, or rewrite scheduling. Capability search remains a distinct operation
because proof selection may be ambiguous even when type normalization must be deterministic.

## Reference language: Lazuli

```lazuli
let sum = values =>
  case values of
    | Nil -> 0
    | Cons(head, tail) -> head + sum tail
  end;

fn main = sum [20, 22];
```

Bindings and function arguments are lazy. A demanded thunk is evaluated once and updated with its
result, so later uses share the value:

```lazuli
fn main =
  let unused = 1 / 0 in
  let shared = 20 + 1 in
  shared + shared;
```

Local recursive functions are explicit language and IR constructs:

```lazuli
fn main =
  let rec factorial n =
    if n == 0 then 1 else n * factorial (n - 1)
  in
  factorial 6;
```

### A compiler written in Lazuli

[`examples/lazuli-brainfuck/compiler.laz`](examples/lazuli-brainfuck/compiler.laz) is a typed,
higher-order Brainfuck-to-WebAssembly compiler with a `Text -> Text` entry point. It validates
nested loops, lowers all eight instructions, constructs WebAssembly sections with unsigned LEB128
lengths, and returns the binary as lowercase hexadecimal text. Its parser composes instruction
streams as `List Int -> List Int` difference lists so larger inputs do not repeatedly copy generated
code.

```sh
deno task run:lazuli-brainfuck
```

The runner asks the GPU to compile the Lazuli compiler, runs that compiler on the GPU evaluator,
decodes and validates the emitted module, and executes it through WebAssembly. It reports
initialization, first-dispatch shader warmup, one-time compiler compilation, and first-input and
warm-input compilation separately, plus a labelled comparison with the specialized Brainfuck-to-IR
GPU pass.

### Current syntax

- declarations: `let name = expression;`, arrow closures such as `value => value + 1`, and the
  compatible zero-or-one-parameter `fn name parameter = expression;` form;
- compile-time specialization: `const answer = 42;` and templates such as
  `const identity a = value => value;`, instantiated with `identity @Int`; every template accepts
  one descriptor, which may be structured by a tuple pattern such as `const pair (a, b) = ...` or a
  named pattern such as `const pair { fst: a, snd: b } = ...`;
- data: `data Type a = Constructor | Constructor(field: a, ...);`; a constructor may declare an
  indexed result such as `data Equal a b = Refl : Equal a a;`, while empty types use
  `data Impossible = ;` (the `List`, `Bytes`, and `Text` types and their constructors are built in);
- types: `Int`, `Bool`, `()`, tuples, right-associative functions, and Hindley–Milner
  let-polymorphism; annotations such as `let main : Int = 42;` are optional unless they select a
  type that inference cannot determine uniquely;
- literals: `i32` integers, `true`/`false`, lazy lists such as `[1, 2]`, named constructor records
  such as `Line { quantity: 2, price: 21 }`, and UTF-8 text such as `"zażółć"`;
- functions: every function accepts one argument; application is juxtaposition and associates left,
  so `f x y` means `(f x) y`;
- tuples and unit: `f (a, b)` passes one tuple, `f ()` passes unit, and their case patterns are
  `| (a, b) -> expression` and `| () -> expression`;
- lazy bindings: `let name = value in body`;
- local recursion: `let rec name parameter = value in body`;
- conditionals: `if condition then consequent else alternate`;
- matching: `case value of | Constructor(bindings...) -> expression ... end`; a zero-arm
  `case impossible of end` is valid when the known scrutinee type has no compatible constructors;
- operators: unary `-`; binary `*`, `/`, `+`, and `-`; comparisons, `==`, and `!=`.

Language keywords are reserved and cannot be used as declaration, parameter, binder, or field names.

Arithmetic is wrapping signed `i32`; division by zero is a structured runtime fault. Constructors
are first-class curried functions, their fields are lazy, and matching reuses the original field
thunks rather than copying or forcing them. For example, `Pair first second` is two unary
applications, while `consume (first, second)` is one application with a tuple. Every type parameter
used by an indexed constructor field must occur structurally in that constructor's result type, so
matching the result can recover the field type without inventing an existential.

### Proofs and typed facts

Indexed constructor results let ordinary Lazuli values carry type evidence. A small logical core is
already expressible from existing language forms:

- `()` witnesses truth;
- an empty data declaration such as `data False = ;` represents falsehood;
- `(a, b)` represents conjunction and `a -> b` represents implication;
- a two-constructor data declaration represents disjunction;
- `data Equal a b = Refl : Equal a a;` represents type equality.

Matching an equality witness introduces a scoped type fact, so a function can safely return a value
at the refined type. Constructors whose result cannot match the scrutinee type are excluded from
coverage, allowing an impossible indexed type to use a zero-arm case. The GPU checks these
refinements during inference; facts never escape the case arm that introduced them. Concrete case
results and results fixed by surrounding expressions are inferred without annotations. A signature
is still required when it chooses a non-principal indexed contract, as `cast` does below.

```lazuli
data Equal a b = Refl : Equal a a;

let cast : Equal a b -> a -> b = proof => value =>
  case proof of
    | Refl -> value
  end;
```

Proof witnesses are ordinary lazy runtime values. Lazuli does not erase them or claim proof
normalization, which matters because recursive programs can diverge. See
[`examples/lazuli/proofs.laz`](examples/lazuli/proofs.laz) for equality composition, false
elimination, and a fact whose payload type is recovered by pattern matching.

List literals use the built-in `Cons(head, tail)` and `Nil`. Text has a built-in representation that
guest code can pattern-match lazily:

```lazuli
fn firstByte text =
  case text of
    | Utf8(bytes) -> case bytes of
      | BytesNil -> 0
      | BytesCons(byte, rest) -> byte
    end
  end;
```

Type descriptors are compile-time-only const arguments. They can be forwarded between const
templates and select cached specializations, but cannot be stored in runtime values or reflected on.
Tuple descriptors use one specialization, such as `pair @(Int, Bool)`. Named descriptors use the
same shape as their declaration, such as `pair @{ fst = Int, snd = Bool }`. A `_` leaf delegates
that part to ordinary inference, as in `pair @(_, Bool)`. The complete tuple or record shape must
still be supplied; specialization is never staged across multiple `@` operations.

Square brackets construct runtime list values such as `[1, 2]`; the corresponding type is written
`List Int`.

## What runs where

The implementation keeps the boundary explicit:

1. A language frontend parses and desugars source on the host into a bounded, flat functional module
   with interned symbols and source byte spans. The Lazuli adapter currently uses the checked-in
   Baba/Wasm parser.
2. The host boundary packs annotations, type parameters, constructor fields, and constructor results
   into one canonical linked-preorder schema buffer. It does not perform production type inference.
3. The persistent WGSL backend validates the uploaded tables, resolves lexical names to de Bruijn
   depths, resolves globals and constructors, validates patterns, and emits resolved core IR.
4. A second persistent WGSL phase validates the canonical schemas, discovers definition SCCs,
   performs Hindley–Milner inference with scoped indexed refinements, checks compatible case
   coverage, and serializes the concrete `main` type in the same schema format.
5. After successful GPU compilation, the host reads the resolved numeric core nodes and emits a
   dependency-free WebAssembly module. Surface names and schemas are not resolved again.
6. `WebAssembly.instantiate()` loads that module and its exported `main()` runs closures, recursion,
   constructors, cases, primitive operations, and declared `Init` capability imports on the CPU's
   WASM engine.
7. The lane-aware WGSL evaluator remains available as a bounded differential oracle. It compares
   backend results in tests and produces the evaluator-specific traces; it is not the normal runtime
   used by the Rust, Haskell, and OCaml `run` commands.

The TypeScript inference implementation is a rank-1/indexed differential-test oracle, not a
production fallback. Higher-rank schemes are checked only by the production GPU path and covered by
canonical-schema, positive/negative subsumption, fuel, and dispatch-quantum tests. Parsing,
syntax-specific desugaring, structural schema packing, and WASM byte emission remain host-side;
semantic resolution, type inference, and core lowering are GPU-side.

The direct WASM backend exports concrete first-order entries, including ordinary
`argument -> result` functions and entries shaped as `$FunctionalInitType -> result`.
`runFunctionalWasmModule()` writes structured arguments into the public value ABI and recursively
decodes structured results within `maximumResultNodes`. Its runtime representation also supports
higher-order closures internally. Lazy-profile globals, bindings, function arguments, and
constructor fields compile to specialized WASM thunks. Each thunk carries a direct code-table slot
and captured environment; its first force transitions from unevaluated through evaluating to a
cached value, and recursive forcing traps as a blackhole. Force sites inline the evaluated fast
path. Closure conversion captures only referenced lexical bindings and forwards existing local or
global suspensions without wrapping them. Immediately applied lambdas and statically saturated
constructors lower directly, partial constructors emit only their remaining application stages, and
repeated nullary constructors share one immutable object.

## Bounded work, latency, and batching

Every charged compiler transition performs constant-bounded work: it inspects one logical record or
edge, pushes at most two durable frames, and allocates at most one record in each arena.
Unification, occurs checks, generalization, instantiation, indexed coverage, SCC walking, and output
serialization all resume from GPU-resident frames. Fuel therefore bounds semantic work, while
cancellation can be observed between dispatches.

Compiler calls without an `AbortSignal` default to the 65,536-transition maximum. Calls carrying a
signal default to 16,384 transitions so cancellation retains a finer observation interval. Profiling
a 1,128-node compiler source showed that mapped state readback, rather than semantic execution,
dominated each approximately 12-ms dispatch: the previous 4,096-transition default required twelve
round trips, while the non-cancellable default completes the same 46,389 semantic transitions in
one. An explicit `maximumStepsPerDispatch` always overrides this choice. Setting it to `1` remains
useful for deterministic fuel, cancellation, and workspace-growth tests, but intentionally turns
every semantic transition into a separate GPU submission and mapped readback. Those tests can take
seconds even when a normal steady-state compilation takes milliseconds.

`compileBatch()` packs every lane's surface, resolved core, schema metadata, inference workspace,
output, and durable state into aggregate GPU buffers. One workgroup advances each program, terminal
lanes become inactive, and the host maps the state array once per quantum. Results retain source
order and are copied into ordinary independently owned module buffers. If one packed lane exhausts
an arena, completed siblings remain valid and only that lane falls back to the scalar elastic-growth
path. Every lane starts with compact input-derived type arenas and at most 64 output records; scalar
inference grows only the exhausted region, while packed inference reruns only exceptional lanes on
that elastic path. Successful packed lanes allocate and copy their independent module buffers once,
after terminal states are known; diagnostic lanes allocate none. Oversized batches overlap at most
two fitting partitions, while recursive splits remain sequential to bound aggregate device memory.
`compileModule()` and compatibility `compile()` retain their scalar paths and share a
resource-weighted admission queue. Lazuli source batches parse and pack each distinct source once;
frontends targeting encoded functional IR already bypass that host parser entirely.

On an RTX 4080 SUPER, the checked-in 1,128-node compiler fixture took a five-sample median 379.3 ms
for sixteen coalesced scalar compilations and 35.5 ms through `compileBatch()`—23.7 versus 2.22 ms
per program, or 10.7× the throughput. The same large fixture scales to median times of 38.6 ms for
64 programs, 45.1 ms for 128, 54.2 ms for 256, and 75.3 ms for 512: respectively 0.60, 0.35, 0.21,
and 0.15 ms per program. End-to-end compilation of one Lazuli source, including parsing and packing,
takes about 37.8 ms warm; an identical 512-source batch takes about 86.2 ms total because frontend
preparation is shared. Sixteen tiny programs take about 13.9 ms total. Use `deno task bench:lazuli`
for repeated measurements and `deno task profile:lazuli-compiler` for cold initialization, parser,
dispatch, quantum, core readback, and scalar-versus-packed profiles on the active WebGPU adapter.
Profile output includes the adapter description and fallback status; software adapters such as
llvmpipe are useful for correctness and synchronization analysis but do not predict hardware-GPU JIT
or execution latency.

## Memory and ownership

Lazuli source values are immutable. The runtime internally updates thunk records to implement
call-by-need sharing.

Each evaluation owns a bounded bump-allocated region for thunks, environments, closures,
constructors, and recursive cycles. Its buffers are destroyed in `finally`, reclaiming the entire
region in constant time without a tracing collector or a background GC process. Memory is not reused
inside one run yet; a program that exceeds its configured region returns `F3003` through the neutral
API (`L3003` through Lazuli) rather than accessing outside a GPU buffer.

Type inference starts with input-derived arena capacities. If one arena fills, only that region is
doubled; live logical records are copied into a replacement workspace and inference resumes without
resetting its phase, fuel, refinements, or results. Device and allocation limits produce an
evidence-rich `F1003` through the neutral API, and failed or cancelled growth destroys both
temporary workspaces.

A successful compilation owns its GPU module buffers. Call `module.destroy()` when finished;
destruction is idempotent. Evaluations borrow the module and automatically release only their own
temporary region and stack buffers.

Strict, effect-free scalar entries use a compact WASM path when every reachable value can remain an
unboxed scalar. Those modules omit linear memory, function tables, allocation, thunk forcing, and
indirect calls. They also omit zero-valued heap and thunk counters, unused fault globals, and unused
function signatures. Eligible additional scalar exports use the same compact module, so runtime
support not reachable from `main` or an export is absent from the artifact. Captureless strict
workers omit their environment parameter, scalar integer workers use native `i32` parameters and
results, and a strict recursive worker with one saturated use is fused into its caller.
`runFunctionalWasmModule()` still reports zero allocation and thunk evaluation through the common
statistics interface. Other entries use an aligned, growing linear-memory arena for closures,
constructors, and thunks. A thunk stores its specialized code slot, captures, state, and cached
value. The exported `thunkEvaluations` counter increments only on the unevaluated slow path, so the
runner reports observable sharing without counting cached forces. Its `allocatedBytes` statistic
reports linear-memory growth during initialization and execution.

### Lambda-set specialization

WASM emission applies
[lambda set specialization](https://www.cs.princeton.edu/~mpmilano/publication/lss/) as an internal
representation pass over the GPU-resolved core. It follows lambda values through globals, lexical
bindings, applications, branches, recursion, and algebraic constructor fields. A singleton set
becomes a direct call, while a finite multi-lambda set becomes tagged direct dispatch. Structurally
known higher-order arguments remain virtual through specialization, which can remove their closure
objects and expose their bodies to the WASM engine.

This pass does not alter semantic function types or the frontend ABI. Incomplete flows, callable
constructors, host operations, sets wider than 64 lambdas, and specialization beyond 512 inline
sites retain the ordinary closure representation and `call_indirect` path. Those limits bound code
growth without changing program behavior. `FunctionalWasmStats.specializedCallSites` reports the
number of emitted direct lambda candidates. The runner keeps this compiler statistic beside its
cached module instead of exporting it in production WASM; unlike the dynamic thunk and allocation
counters, it is static for one emitted module.

```sh
deno task bench:functional-comptime
deno task bench:functional-wasm
```

The comptime benchmark compares bounded-WASM scalar and batch execution with explicit GPU controls
and unchanged incremental-result reuse. The runtime benchmark emits and runs a 1,000-iteration
higher-order loop, its direct first-order form, an uncurried tail worker, and a hand-written
structured-control-flow WASM loop. The last pair determines whether another CFG/SSA IR would
currently buy runtime performance rather than merely add a compiler stage. It separately reports
cached emission, fresh-instance execution, and calls on one warm instance so setup cost is not
mistaken for generated-code cost.

## Packed ABI reference

Most frontends should use `buildFunctionalSurfaceModule()` as shown above. Consumers that generate
the packed ABI directly can use the lower-level constants and record tables in this section. The
smallest raw module below is assembled without a parser or Lazuli source.

`buildFunctionalSurfaceModule()` is exported for frontends that prefer typed surface objects over
packing words directly. It preserves supplied source spans and appends the reserved unit and pair
declarations required by the current ABI. The Rust functional profile is a complete example of that
path.

```ts
import {
  compileFunctionalModuleToWasm,
  FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  FUNCTIONAL_MODULE_ABI_VERSION,
  FUNCTIONAL_NO_INDEX,
  FunctionalEvaluationProfile,
  FunctionalExpressionTag,
  FunctionalTypecheckingProfile,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "@mewhhaha/gpufuck";

const encodedModule = {
  abiVersion: FUNCTIONAL_MODULE_ABI_VERSION,
  sourceByteLength: 2,
  evaluationProfile: FunctionalEvaluationProfile.StrictEager,
  typecheckingProfile: FunctionalTypecheckingProfile.HindleyMilnerIndexed,
  primitiveCapabilities: FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  nodeWords: Uint32Array.of(
    FunctionalExpressionTag.Integer,
    0,
    2,
    42,
    FUNCTIONAL_NO_INDEX,
    FUNCTIONAL_NO_INDEX,
    FUNCTIONAL_NO_INDEX,
    FUNCTIONAL_NO_INDEX,
  ),
  definitionWords: Uint32Array.of(0, 0, 0, 2),
  typeWords: new Uint32Array(),
  constructorWords: new Uint32Array(),
  nodeCount: 1,
  definitionCount: 1,
  typeCount: 0,
  constructorCount: 0,
  entrySymbol: 0,
  symbolNames: ["program_result"],
  definitionTypes: [{ annotation: null }],
  typeDeclarations: [],
} as const;

const device = await requestWebGpuDevice();
try {
  const [compiler, evaluator] = await Promise.all([
    GpuFunctionalCompiler.create(device),
    GpuFunctionalEvaluator.create(device),
  ]);
  const compilation = await compiler.compileModule(encodedModule);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
  try {
    console.log(compilation.module.entryType);
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const instantiated = await WebAssembly.instantiate(bytes);
    console.log((instantiated.instance.exports.main as () => number)());

    const execution = await runFunctionalWasmModule(compilation.module);
    console.log(execution.value);
    console.log(execution.stats);
    console.log(await evaluator.evaluate(compilation.module)); // Differential oracle.
  } finally {
    compilation.module.destroy();
  }
} finally {
  device.destroy();
}
```

The module declares its ABI version, source extent, entry symbol, semantic profiles, and complete
primitive capability set before its four typed-array tables. The host validates this envelope and
all record lengths before allocating or submitting GPU work. Unsupported versions, profiles, or
capabilities fail with evidence at that boundary. Compile diagnostics use frontend-neutral `F` codes
and UTF-8 byte spans; evaluator faults use `F3001`–`F3012`, WASM runtime integration uses `F31xx`,
linking uses `F40xx`, and invalid WASM boundary values use `F41xx`.

Unit and pair are core primitives represented by the reserved constructor names exported as
`FUNCTIONAL_UNIT_CONSTRUCTOR_NAME` and `FUNCTIONAL_PAIR_CONSTRUCTOR_NAME`. Other constructor and
type names belong entirely to the frontend.

Every expression is one eight-word record in parent-before-child order. The common fields are tag,
start byte, end byte, payload, three child indices, and parent index; absent edges use
`FUNCTIONAL_NO_INDEX`. Tag-specific meanings are:

| Expression tag | Payload                    | Child 0              | Child 1               | Child 2   |
| -------------- | -------------------------- | -------------------- | --------------------- | --------- |
| `Integer`      | signed i32 bits            | —                    | —                     | —         |
| `Boolean`      | `0` or `1`                 | —                    | —                     | —         |
| `Name`         | symbol                     | —                    | —                     | —         |
| `Let`          | bound symbol               | value                | body                  | —         |
| `StrictLet`    | bound symbol               | value                | body                  | —         |
| `LetRec`       | bound symbol               | parameter lambda     | body                  | —         |
| `If`           | `0`                        | condition            | consequent            | alternate |
| `Lambda`       | parameter symbol           | body                 | —                     | —         |
| `Apply`        | `0`                        | callee               | argument              | —         |
| `StrictApply`  | `0`                        | callee               | argument              | —         |
| `Unary`        | `FunctionalUnaryOperator`  | operand              | —                     | —         |
| `Binary`       | `FunctionalBinaryOperator` | left                 | right                 | —         |
| `Case`         | `0`                        | scrutinee            | first arm or no index | —         |
| `CaseArm`      | constructor symbol         | binder chain or body | next arm or no index  | —         |
| `PatternBind`  | binder symbol              | next binder or body  | —                     | —         |

Definitions are four words: symbol, root node, start byte, and end byte. Algebraic types are five
words: symbol, first constructor, constructor count, start byte, and end byte. Constructors are five
words: symbol, owner type index, arity, start byte, and end byte. The exported `Functional*Word`
objects are the authoritative offsets, and the structural schema types describe annotations,
parameters, fields, and optional indexed constructor results.

`Let` and `Apply` encode call-by-need boundaries; `StrictLet` and `StrictApply` encode eager ones.
Core lowering normalizes each pair to the ordinary `Let` or `Apply` core tag and stores the resolved
mode in the final core-node word. Backends consume that word directly and do not infer source
language strictness.

`compileFunctionalModuleToWasm()` consumes only a successfully GPU-resolved module and returns valid
WASM bytes. `runFunctionalWasmModule()` is the convenience path that validates an optional `init`,
emits, instantiates, calls `main`, decodes its scalar result, and reports the number of thunks
actually evaluated together with allocated runtime bytes. Modules without declared host capabilities
remain import-free and keep the original zero-argument `main()` ABI. Lazy boundaries preserve unused
bindings, arguments, and constructor fields and share every demanded thunk; strict boundaries
evaluate before binding. Unselected conditional branches remain unevaluated in both profiles.
`GpuFunctionalEvaluator` remains available for differential testing and detailed traces; it accepts
recursively nested declared constructors and supports weak-head and bounded deep results, batching,
fuel, heap, stack, and cancellation.

## Lazuli compatibility API

This source-oriented wrapper parses Lazuli and invokes the functional module API. Its existing
types, diagnostics, text/list conveniences, and `mainType` property remain compatible. Its
`compileBatch()` method accepts an ordered source array and returns one result per source.

```ts
import { GpuLazuliCompiler, GpuLazuliEvaluator, requestWebGpuDevice } from "./mod.ts";

const device = await requestWebGpuDevice();
try {
  const compiler = await GpuLazuliCompiler.create(device);
  const compilation = await compiler.compile("let main = value => value + 1;", {
    maximumSteps: 1_000_000,
    maximumStepsPerDispatch: 4_096,
  });
  if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);

  try {
    const evaluator = await GpuLazuliEvaluator.create(device);
    const result = await evaluator.evaluate(compilation.module, {
      input: { kind: "integer", value: 41 },
      resultForm: "deep",
      maximumResultNodes: 4_096,
      maximumSteps: 100_000,
      maximumStepsPerDispatch: 4_096,
      heapSlots: 4_096,
      stackFrames: 1_024,
    });
    console.log(result);
  } finally {
    compilation.module.destroy();
  }
} finally {
  device.destroy();
}
```

`input` accepts integers, Booleans, unit, pairs, UTF-8 text, and recursively nested named
constructors. It is applied lazily to `main`; `evaluateBatch` accepts a parallel `inputs` array.
Results remain weak-head by default. `resultForm: "deep"` forces constructor fields and returns a
complete tree bounded by `maximumResultNodes`, with runtime faults isolated to their scalar
evaluation or batch lane.

Compilation diagnostics use UTF-8 byte spans (`L1001`–`L2010`, `L2101`–`L2104`). Runtime faults
cover invalid modules and inputs, fuel, heap and stack limits, blackholes, division by zero,
oversized deep results, and cyclic results (`L3001`–`L3011`).

## Architecture boundary

The parser-independent boundary is implemented:

1. Neutral module, schema, diagnostic, compiled-module, evaluator, and value types are public.
2. Entry symbol, primitive capabilities, evaluation strategy, and typechecking mode are explicit.
3. `compileModule()` accepts encoded modules without importing or loading a parser.
4. Lazuli is a thin parse/desugar adapter with its original API and diagnostic codes preserved.
5. The neutral evaluator treats declared constructors literally; Lazuli-only text/list host sugar is
   enabled only through the compatibility evaluator.
6. The direct WASM backend consumes numeric resolved core nodes and does not import any frontend.
7. Brainfuck remains outside the functional package and contract.

The WGSL kernels and several internal implementation files retain legacy Lazuli names while they are
moved mechanically behind the neutral package. They consume only the encoded functional tables on
the generic path; no parser state or Lazuli source syntax crosses the boundary.

## Contributing and verification

```sh
deno task check
deno task fmt
deno task lint
deno task test
```

The test task runs files in parallel with two Deno jobs. Quantum-1 transition invariance, exact-fuel
boundaries, cancellation, and forced growth from capacity one are synchronization stress tests and
remain slower than ordinary language tests by design.

Measure steady-state, end-to-end Lazuli compilation time after compiler and device setup:

```sh
deno task bench:lazuli
```

The benchmark covers fixed small, recursive, algebraic-data-type, indexed-proof, polymorphic, and
64-definition programs. Module destruction is excluded from each timing sample. Use
`deno task bench:lazuli --json` when capturing machine-readable results for comparisons.

Regenerate the checked-in parser after changing `language/lazuli/grammar.baba`:

```sh
deno task generate:lazuli
```

The generator and runtime are pinned to `jsr:@mewhhaha/baba@4.0.0`. Generated assets are excluded
from `deno fmt` so regeneration remains byte-for-byte reproducible with that published generator.

## Deliberate limits

- Effect Core supports concrete first-order scalar, tuple, nominal, text, bytes, array, slice, and
  resource operation signatures with at most 32 distinct effectful operations per module.
  Higher-order operation values and open effect-row variables remain frontend concerns. Suspending
  host operations require the async replay runner rather than the synchronous direct WASM runner.
- Source is capped at 1 MiB, surface trees at 65,536 nodes, semantic depth at 512, and constructor
  arity at 64. Extremely deep concrete syntax can reach the generated parser's stack-safe limit
  sooner and returns `F1003` through the neutral API.
- Compilation has a default budget of 1,000,000 persistent semantic transitions and returns `F1003`
  when that fuel is exhausted.
- The current functional core uses Hindley–Milner inference with GADT-style indexed constructor
  results plus explicitly annotated predicative rank-N function parameters, not full dependent or
  impredicative types. Ordinary and recursive bindings are inferred, including indexed cases with a
  concrete result or a result fixed by their context. An annotation remains necessary at a
  higher-rank boundary and when it selects a non-principal indexed contract whose result depends on
  an arm-local refinement. The entry definition must resolve to a concrete type.
- Every type parameter used by an indexed constructor field must occur structurally in that
  constructor's result. Parameters absent from the result would be existential and remain
  unsupported.
- Proof witnesses are runtime values and are not erased. Primitive operand errors, constructor
  mismatches, inaccessible arms, and non-exhaustive cases are compile diagnostics.
- Pattern fields are flat binders; nested destructuring is expressed with a nested `case`.
- Structured constructor results report only their outer constructor by default; opt-in deep results
  force and serialize fields within `maximumResultNodes`.
- Direct WASM execution accepts one concrete first-order argument and result, or an `Init -> result`
  entry. `FunctionalWasmValueAbi` v1 defines the shared eight-byte values, sixteen-byte object
  headers, constructor fields, and boxed wide numerics used by arguments, results, and host
  capabilities. Cyclic structured results and higher-order boundary values are rejected.
- Direct public WASM execution relies on the engine's stack and memory traps. Required compile-time
  IEEE execution uses a separate fuel-instrumented artifact; it does not accept GPU dispatch, heap,
  or continuation-stack controls.
- A GPU run has bounded fuel, heap, and continuation stack. Generated WASM uses a reusable explicit
  free list but does not trace unreachable objects or infer ownership.
- GPU compilation is ordered within one module; `compileBatch()` executes heterogeneous modules as
  independent packed lanes. Evaluation can likewise batch heterogeneous modules in independent
  runtime regions.

## Historical Brainfuck prototype

The Brainfuck path uploads UTF-8 source and emits one 8-byte `{ opcode: u32, operand: u32 }` record
per source byte. Ignored bytes become `NOP`, and loop operands are absolute next-program-counter
targets. The IR remains GPU-resident until `readInstructions()` is explicitly requested, and its
owner must be destroyed when finished. It shares low-level WebGPU setup with the repository but is
not an input, IR, or compatibility requirement of the functional compiler backend.
