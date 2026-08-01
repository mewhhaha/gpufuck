# gpufuck

gpufuck is a typed compiler backend for functional languages. You bring a parser and your language
rules; gpufuck resolves names, infers and checks types, produces a small Functional Core, and emits
WebAssembly.

Use it when you are building a language, DSL, code generator, or staged system and want to own the
source language without also building its typechecker and Wasm backend.

```text
source ──► your parser ──► your lowering ──► gpufuck Surface
                                                │
                                      resolve + infer + check
                                                │
                                                ▼
                                         Functional Core
                                           │          │
                                           ▼          ▼
                                      evaluate     WebAssembly
```

gpufuck does not prescribe syntax, parse files, or silently reinterpret your language. Records,
lists, modules, traits, and source-level control flow mean exactly what your frontend lowers them
to.

## Should I use it?

gpufuck is a good fit when:

- your language is expression-oriented and mostly functional;
- Hindley–Milner inference, algebraic data types, effects, or indexed constructors cover its type
  system;
- you want runnable Wasm rather than only a typechecking library;
- you can lower source constructs into functions, immutable bindings, calls, constructors, and
  `case`; and
- you are comfortable depending on a pre-1.0 API.

It is probably the wrong backend when you need arbitrary mutation, exceptions with stack unwinding,
dependent or impredicative types, a stable C ABI without an adapter, or excellent single-file cold
compile latency.

The default integration does not require a GPU. `FunctionalCompilerService` compiles ordinary HM
modules on the CPU and creates a resident WebGPU compiler only for a GPU-only profile or when you
explicitly request `{ backend: "gpu" }`.

## Install

```sh
deno add jsr:@mewhhaha/gpufuck
```

The package supports Deno 2.9+. Its public API includes WebGPU types, so enable Deno's WebGPU
library even if your application initially uses the CPU compiler:

```json
{
  "unstable": ["webgpu"]
}
```

A GPU deployment additionally needs a WebGPU adapter. `requestWebGpuDevice()` reports whether the
runtime flag, adapter discovery, or device creation failed. A software adapter is useful for
correctness, not performance measurements.

## Compile your first module

This complete example lowers `main = 40 + 2`, infers its type, executes it through the Wasm runtime,
and obtains a reusable Wasm binary:

```ts
import {
  BinaryOperator,
  buildSurfaceModule,
  compileModuleToWasm,
  FunctionalCompilerService,
  runWasmModule,
  surface,
} from "@mewhhaha/gpufuck";

const source = "main = 40 + 2";
const encoded = buildSurfaceModule(
  [{
    name: "main",
    parameters: [],
    annotation: null,
    body: surface.binary(
      BinaryOperator.Add,
      surface.integer(40),
      surface.integer(2),
    ),
  }],
  [],
  "main",
  new TextEncoder().encode(source).byteLength,
);

const compiler = new FunctionalCompilerService();
try {
  const compilation = await compiler.compileModule(encoded);
  if (!compilation.ok) {
    const diagnostic = compilation.diagnostics[0];
    throw new Error(`${diagnostic.code}: ${diagnostic.message}`);
  }

  try {
    const execution = await runWasmModule(compilation.module);
    console.log(execution.value); // { kind: "integer", value: 42 }

    const wasm = await compileModuleToWasm(compilation.module);
    console.log(`emitted ${wasm.byteLength} bytes`);
  } finally {
    compilation.module.destroy();
  }
} finally {
  await compiler.destroy();
}
```

The objects have separate lifetimes:

- an encoded module is immutable host memory and can be cached;
- a successful compilation owns a resolved module and must be destroyed;
- `FunctionalCompilerService` owns caches and, if used, its GPU device;
- emitted Wasm bytes are ordinary application data.

CPU-backed modules make `destroy()` a no-op, but always calling it keeps the same frontend correct
when its compiler policy changes.

## Choose the API for your application

| Goal                                                   | Recommended API                                     |
| ------------------------------------------------------ | --------------------------------------------------- |
| Compile ordinary modules and reuse unchanged work      | `FunctionalCompilerService`                         |
| Force host-only semantic compilation                   | `new FunctionalCompilerService({ backend: "cpu" })` |
| Force GPU semantic compilation                         | `new FunctionalCompilerService({ backend: "gpu" })` |
| Control a shared GPU device yourself                   | `GpuCompiler.create(device)`                        |
| Execute with the general runtime and host imports      | `runWasmModule()` or `runWasmExport()`              |
| Evaluate compatible Core directly on WebGPU            | `GpuEvaluator`                                      |
| Emit a standalone module                               | `compileModuleToWasm()`                             |
| Put independent entries in one shared-runtime artifact | `compileModulesToWasm()`                            |
| Compile independent modules in workers                 | `ParallelFunctionalCompilerService`                 |
| Publish structural host-facing values                  | `WasmCompilationOptions.canonicalAbi`               |
| Generate matching Core Wasm and WIT                    | `compileModuleToComponentBoundary()`                |

Start with `FunctionalCompilerService` and `runWasmModule()`. Choose the lower-level compiler,
evaluator, batch, or boundary APIs only after your deployment needs them.

## Build a frontend

A frontend has four responsibilities:

1. Parse source and enforce syntax-specific rules.
2. Lower source expressions and declarations into Surface.
3. Describe source types as `TypeSchema` values.
4. Translate gpufuck diagnostics back into filenames and source-language wording.

`buildSurfaceModule()` handles symbol interning, currying, the packed compiler ABI, and the reserved
unit and pair types. It does not decide what a source construct means.

### Lower source concepts deliberately

| Source concept                 | Typical Surface representation                              |
| ------------------------------ | ----------------------------------------------------------- |
| Literal or variable            | `surface.integer()`, `float32()`, `text()`, `name()`        |
| Multi-parameter function       | `surface.lambda(["x", "y"], body)`                          |
| Call                           | `surface.apply(callee, ...arguments)`                       |
| Immutable local                | `surface.let(name, value, body)`                            |
| Required source order          | `surface.sequence(name, value, body)`                       |
| Conditional                    | `surface.if(condition, consequent, alternate)`              |
| Algebraic value                | a declared constructor applied as an ordinary function      |
| Pattern match                  | `surface.case(value, arms, otherwise)`                      |
| Record                         | usually one constructor; projections become `case` bindings |
| List                           | usually `Nil \| Cons element list`                          |
| Trait or interface             | an explicit record/dictionary argument                      |
| Source module                  | a `ModuleArtifact`, then `linkModules()`                    |
| Deferred value                 | `surface.delay()` and `surface.force()`                     |
| Mutable indexed storage        | the `surface.store*` operations                             |
| Unrecoverable source operation | `surface.runtimeFault(message)`                             |

Surface is intentionally smaller than most source languages. A frontend should keep its own AST and
lower into Surface at one boundary rather than use Surface as its parser AST.

Store writes and growth are persistent unless the frontend supplies `{ owned: true }` to
`surface.storeWrite` or `surface.storeGrow`. That option is a proof obligation: the Store operand
must have no observable aliases after its operands finish evaluating. Linear-memory WebAssembly then
writes through the source allocation, growing geometrically when an append exceeds its spare
capacity; WasmGC reuses the backing array for same-length writes.

### Declare algebraic types

Constructors are globally named callable values. This declares `Option value`, constructs `Some 42`,
and consumes it:

```ts
const optionType = {
  name: "Option",
  parameters: ["value"],
  constructors: [{
    name: "None",
    fields: [],
  }, {
    name: "Some",
    fields: [{
      name: "value",
      type: { kind: "parameter" as const, name: "value" },
    }],
  }],
};

const value = surface.apply(surface.name("Some"), surface.integer(42));
const unwrapped = surface.case(value, [{
  constructor: "Some",
  binders: ["value"],
  body: surface.name("value"),
}], {
  body: surface.integer(0),
});
```

Pass `optionType` in the second argument to `buildSurfaceModule()`. Constructor fields and function
annotations use the same `TypeSchema` vocabulary. An annotation may be `null`; exported and entry
types still have to resolve to concrete first-order types.

### Preserve source locations

Spans are UTF-8 byte offsets, not UTF-16 indices. Attach them while lowering:

```ts
const at = surface.at({ startByte: 42, endByte: 47 });
const sum = at.binary(BinaryOperator.Add, at.integer(20), at.integer(22));
```

The scoped builder stamps every node it creates, including each curried lambda or application in an
expanded spine. Pass the complete source byte length to `buildSurfaceModule()`. After linking,
`locateDiagnostic()` maps a linked offset back to the source module; your frontend remains
responsible for line/column conversion and user-facing terminology.

### Link source modules

Lower each source module independently, describe its typed imports and exports with
`createModuleArtifact()`, then call `linkModules()` on the entry artifact and its dependencies. The
linker qualifies private names, follows reachable imports, checks source contracts, and reports
`LinkError` separately from semantic diagnostics.

Do not concatenate Surface definition arrays yourself. That loses module ownership, source offsets,
and typed import checks.

## Compile, run, or publish Wasm

Compilation returns either diagnostics or a resolved `CompiledModule`. From that one value you can:

- call `runWasmModule()` for the entry point;
- call `runWasmExport()` for a named source export;
- call `compileModuleToWasm()` to retain the binary;
- use `GpuEvaluator` when the supported WebGPU evaluator is useful; or
- inspect inferred types, effects, exports, and resolved Core metadata.

`runWasmModule()` is the broadest execution path. It supports host capabilities, text, f64, stores,
runtime faults, and bounded execution. `GpuEvaluator` delegates unsupported operations to bounded
Wasm, so select it for its execution profile rather than as a requirement.

For a program with host capabilities, supply the declared fields through the runner's `init` option.
Synchronous capabilities use `runWasmModule()`; suspending operations use `runWasmModuleAsync()`.
Missing or incorrectly typed bindings fail at the host boundary instead of becoming an untyped Wasm
import error.

### Wasm backends

The default linear-memory backend supports the full private runtime, Canonical ABI adapters, SIMD,
branch hints, and component boundaries. `{ backend: "wasm-gc" }` is useful when your target supports
WasmGC, but it deliberately does not support every linear-memory feature.

For a stable caller-facing boundary, pass a `CanonicalAbiInterface` as `canonicalAbi`. This keeps
gpufuck's tagged heap private and publishes structural memory32 records, variants, arrays, text,
booleans, signed i64, f32, and f64. See [Canonical Core Wasm adapters](docs/canonical-abi.md) for
layouts, ownership, post-return, WIT, components, and `ComponentReloadSlot`.

## Effects and host capabilities

Effect operations are typed callable values. Their labels flow through higher-order calls and are
included in inferred definition and export effects:

```ts
const tick = defineEffectOperation({
  name: "tick",
  parameter: { name: "value", type: { kind: "integer" } },
  result: { kind: "integer" },
  effects: effectSet("Clock.Tick"),
  body: surface.binary(
    BinaryOperator.Add,
    surface.name("value"),
    surface.integer(1),
  ),
});
```

`surface.withEffectHandler()` installs lexical evidence for an operation. A pure replacement can
discharge its label, including through higher-order code that receives the replacement. It is not
dynamic interception: a function that already closed over the global operation stays effectful.

Host capabilities describe the operations supplied by an application at runtime. Keep this boundary
small and structural; it becomes both the evaluator contract and the Wasm import contract.

## SIMD, demand, and branch hints

The fixed-vector library has portable definitions and optional native Wasm SIMD lowering. Include
`FIXED_VECTOR_TYPE_DECLARATIONS` and `FIXED_VECTOR_DEFINITIONS`, construct expressions with `f32x4`,
then emit with `{ simd: "wasm-simd" }`.

Provably demanded or safely materialized F32x4 values remain in `v128` across compatible calls,
conditions, projections, and let-bound chains. Genuinely lazy and generic boundaries use the boxed
representation. Available operations include arithmetic, lane access and replacement, comparisons
and masks, `select`, horizontal addition, shuffle, and swizzle.

Ordinary `let` bindings and application arguments are demand-driven. The compiler deletes unused
bindings, evaluates a demanded value at most once, and may inline, sink, or eagerly materialize a
pure total value when that preserves behavior. Use `surface.sequence(name, value, body)` when
`value` must run before `body`, including ordered effects and intentional faults. `surface.delay()`
and `surface.force()` remain available when a thunk is itself part of the program's value model.

Frontends can attach non-semantic branch metadata:

```ts
surface.if(condition, fastPath, slowPath, { likely: "consequent" });
```

The linear-memory backend emits the standard `metadata.code.branch_hint` custom section. Generated
fault paths are cold, and a thunk's resolved cache path is likely. Engines that ignore the section
preserve the same behavior.

## Diagnostics and resource limits

Expected compile and runtime failures are structured:

| Range                            | Meaning                              |
| -------------------------------- | ------------------------------------ |
| `F1001`–`F1003`                  | structure and name resolution        |
| `F2001`–`F2104`                  | inference, annotations, and coverage |
| `F3001`–`F3013`, `F3101`–`F3104` | evaluation faults                    |
| `F4001`–`F4007`                  | module linking                       |
| `F4101`–`F4102`                  | host and Wasm boundaries             |
| `F5001`–`F5002`                  | compile-time evaluation              |
| `F6001`–`F6006`                  | Storage Core verification            |

Compiler and evaluator options bound semantic steps, result nodes, result bytes, dispatch work,
heap, and continuation depth. Cancellation uses `AbortSignal`. Invalid API options throw
`TypeError`; WebGPU setup failures preserve their cause; source-program failures return diagnostics
or typed runtime faults.

Never turn a diagnostic into a generic “type error.” Preserve its code and evidence, locate its byte
span in the owning source, and render the final message in your language's vocabulary.

## Long-lived and parallel builds

`FunctionalCompilerService` caches by encoded module, semantic fingerprint, and literal-only update.
Keep one service for the lifetime of a language server, build daemon, or application session.

Use `ParallelFunctionalCompilerService` for independent modules, not for splitting one module. It
can return compiled Core, emit separate Wasm modules, or assemble one deterministic shared-runtime
artifact. Transfer encoded modules with `encodeModuleForTransfer()` when you manage workers
yourself; immutable effect sets are not directly structured-cloneable.

## Reference frontends

The repository contains complete frontends to read as implementation examples. They are deliberately
excluded from the published package.

| Frontend                                            | Useful reference                                                |
| --------------------------------------------------- | --------------------------------------------------------------- |
| [Gleam](examples/gleam/README.md)                   | strict inference, project linking, records, and stdlib coverage |
| [Lazuli](examples/lazuli/README.md)                 | small syntax, indexed constructors, host values, and laziness   |
| [Sweep](examples/sweep/README.md)                   | explicit checking without inference and editor integration      |
| [JavaScript AOT](examples/javascript-aot/README.md) | imperative control-flow lowering and lexical exceptions         |

Ducklang is the main out-of-repository consumer. It uses gpufuck as its only code generator.

## Performance and project status

gpufuck is not currently a faster replacement for a mature compiler on ordinary cold builds. On the
recorded Ryzen 7 7800X3D and RTX 4080 SUPER benchmark, one large Gleam module is 4.84× slower and an
internal edit is 12.3× slower. The useful cases are different: an unchanged large module is about
271× faster through immutable reuse, and 1,024 independent modules compiled through fused workers
are about 1.8× faster than the comparison Gleam build.

Those numbers are workload-specific and have changed as the benchmark became fairer. Read
[BASELINE.md](BASELINE.md) for raw measurements and methodology before making an architecture
decision. [TASKS.md](TASKS.md) records the measured remaining work.

The project is pre-1.0. The packed ABI, structured diagnostics, execution paths, and published
package are tested; the frontend API may still change between minor releases.

## Documentation

| Document                               | Purpose                                             |
| -------------------------------------- | --------------------------------------------------- |
| [Canonical ABI](docs/canonical-abi.md) | public Wasm layouts, ownership, WIT, and components |
| [ARCHITECTURE.md](ARCHITECTURE.md)     | internal boundaries and invariants                  |
| [CHALLENGES.md](CHALLENGES.md)         | hard limits and degenerate cases                    |
| [DESIGN.md](DESIGN.md)                 | a source language designed around this backend      |
| [BASELINE.md](BASELINE.md)             | reproducible performance evidence                   |
| [DEVELOPMENT.md](DEVELOPMENT.md)       | contributing, verification, and publishing          |
| [CHANGELOG.md](CHANGELOG.md)           | release history                                     |

Only exports from `functional.ts` are public API. Files under `src/` are implementation details even
when a reference frontend imports them inside this repository.

## License

MIT. See [LICENSE](LICENSE).
