# gpufuck

`gpufuck` exists to answer one question: can a compiler's semantic phases run fast on a GPU? A
language frontend supplies syntax, source-language rules, and desugaring; gpufuck packs that into a
portable Functional Surface, resolves and typechecks it on WebGPU, and produces a resolved
Functional Core. Core programs are executed by the GPU Core evaluator or compiled to WebAssembly.

Much of what did not serve that question has been removed — five frontends, the Brainfuck GPU
compiler, incremental compilation, row types, existentials, and the browser playground are gone. The
WebAssembly backend is not: it is the code generator
[Ducklang](ARCHITECTURE.md#7-external-consumers) compiles through.

```text
source text
    │  your parser, module system, and language-specific checks
    ▼
Functional Surface (packed module ABI, version 5)
    │  optional static linking of module artifacts
    ▼
CPU: symbol lookup and the lowering plan
GPU: Core lowering, dependency SCCs, Hindley–Milner inference, coverage
    ▼
resolved Functional Core
    ├─► GPU Core evaluator, delegating to bounded Wasm where WGSL cannot go
    └─► WebAssembly artifact (compileFunctionalModuleToWasm)
```

## Status

This is a research project mid-retarget. Two things are true and worth stating before the API.

**It is not yet fast.** [BASELINE.md](BASELINE.md) is the measured record, reproducible with
`deno task bench:throughput`. On a Ryzen 7 7800X3D with an RTX 4080 SUPER and Deno 2.9.2, marginal
cost per module at batch 1024:

| Work                                 | Runs on | Per module |
| ------------------------------------ | ------- | ---------: |
| Parsing plus inference               | CPU     |    39.3 µs |
| Hindley–Milner inference alone       | CPU     |    10.2 µs |
| Host symbol lookup and lowering plan | CPU     |     3.6 µs |
| Hindley–Milner inference             | GPU     |    99.7 µs |

The GPU is **9.7× slower** than the CPU at the one phase it replaces, and it loses at every batch
size — the gap converges rather than crossing. Single-compile latency is a separate problem: Deno's
`mapAsync` stalls about 11.4 ms per await even with nothing submitted, which is the whole of the
one-module number. And because parsing is 74% of the CPU path and stays on the CPU, a free
instantaneous GPU would still cap end-to-end speedup at **1.35×**.

The cause of the slope is structural. The persistent Core-lowering, inference, and evaluator kernels
are all `@compute @workgroup_size(1)` — one lane per module running a serial state machine, with no
data parallelism inside a program. The single exception only copies a lowering plan the host already
computed. Fixing that is the point of the current work, and BASELINE.md records its kill criteria.

**Execution spans two runtimes.** Portable WGSL has no `i64` or `f64` and does not promise host-Wasm
rounding, so the GPU evaluator cannot execute 64-bit floats, portable whole-number f64, text, bytes,
runtime faults, buffer append, `Store` operations, structural equality, f32 division, or f32 square
root. `GpuFunctionalEvaluator.evaluate` inspects resolved Core before dispatch and delegates any
program using them to bounded WebAssembly execution, so the choice of runtime is not a caller
concern. That path takes `maximumSteps` and result limits but rejects the GPU-specific dispatch,
heap, and stack options with a `TypeError`; a module declaring host capabilities has to go through
`runFunctionalWasmModule` instead, because that is where the runner `init` is supplied.

## Installation

Requires Deno 2.9 or newer, Deno's unstable WebGPU API, and a WebGPU adapter. There is no CPU
fallback: `requestWebGpuDevice()` throws with setup evidence when WebGPU is disabled, adapter
discovery fails, or no adapter is available. A software adapter works for correctness but does not
predict hardware latency.

gpufuck is not published to a registry. It is consumed by importing `functional.ts` from a checkout
beside your own, which is how Ducklang uses it:

```ts
import { GpuFunctionalCompiler, requestWebGpuDevice } from "../gpufuck/functional.ts";
```

Your `deno.json` needs the unstable WebGPU API:

```json
{
  "unstable": ["webgpu"]
}
```

`functional.ts` is the whole language-neutral API — compilation, linking, evaluation, the
WebAssembly backend, storage planning, and the comptime executor. The bundled Lazuli, Gleam, and
JavaScript AOT frontends are repository examples that live outside it; a consumer never imports
`src/` directly.

## Compile and run a first module

This program constructs `main = 40 + 2`, asks the GPU to resolve and infer it, and evaluates it:

```ts
import {
  buildFunctionalSurfaceModule,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
  surface,
} from "../gpufuck/functional.ts";

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
  const evaluator = await GpuFunctionalEvaluator.create(device);
  const compilation = await compiler.compileModule(module);
  if (!compilation.ok) {
    const diagnostic = compilation.diagnostics[0];
    throw new Error(
      `${diagnostic.code} at bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ` +
        diagnostic.message,
    );
  }

  try {
    const execution = await evaluator.evaluate(compilation.module);
    if (!execution.ok) throw new Error(`evaluation faulted: ${execution.fault.code}`);
    console.log(execution.value); // { kind: "integer", value: 42 }
  } finally {
    compilation.module.destroy();
  }
} finally {
  device.destroy();
}
```

Reuse one `GpuFunctionalCompiler` for the lifetime of a device: creation builds shaders and
pipelines, and `compileBatch()` is where batching pays off. A successful `GpuFunctionalModule` owns
GPU buffers, so always `destroy()` it in `finally`.

## Emit a WebAssembly artifact

The same compiled module is the backend's input. `compileFunctionalModuleToWasm()` returns the
binary — `linear-memory` by default, `wasm-gc` on request — and `runFunctionalWasmModule()` runs it
in the host engine and decodes the result:

```ts
import { compileFunctionalModuleToWasm, runFunctionalWasmModule } from "../gpufuck/functional.ts";

const bytes = await compileFunctionalModuleToWasm(compilation.module);
await Deno.writeFile("main.wasm", bytes);

const execution = await runFunctionalWasmModule(compilation.module);
console.log(execution.value); // { kind: "integer", value: 42 }
```

Host capability declarations and `wasmExports` are consumed here: capabilities become the imported
host boundary supplied through the run options' `init`, and exported definitions become module
exports.

## Connect a language frontend

A frontend parses and enforces its own rules, desugars into functions, immutable bindings,
applications, conditionals, constructors, and cases, converts nominal declarations and annotations
into `FunctionalTypeSchema` values, attaches UTF-8 byte spans, and translates neutral diagnostics
back into source terminology.

`buildFunctionalSurfaceModule()` interns names, curries multi-parameter definitions, installs the
reserved unit and pair constructors, and packs the public ABI. Multiple parameters become nested
unary lambdas, calls become left-associated `apply` nodes, tuples use the reserved pair constructor,
nested patterns become nested flat `case` expressions, and traits become explicit dictionaries —
lists, records, and source modules are not Core primitives. `linkFunctionalModules()` combines
several `FunctionalModuleArtifact` values into one whole program before GPU compilation, qualifying
names and checking typed imports against exports.

### Surface primitives

The `surface` builder covers literals, `name`, `lambda`, `apply`, `binary`, `unary`, `convert`,
`equal`, `structuralEqual`, `store*`, and `runtimeFault`. Three of its features exist because two
unrelated frontends independently hand-rolled the same workaround, and each of them deletes frontend
code:

```ts
// Spans: every surface node kind carries an optional span, and `at` stamps it.
const at = surface.at({ startByte: 42, endByte: 47 });
at.binary(FunctionalBinaryOperator.Add, at.integer(20), at.integer(22));

// Parameter lists fold right, so a frontend does not curry by hand.
surface.lambda(["x", "y"], surface.name("y"));

// A case default: the arms it omits are filled in, and the fallback binds once.
({
  kind: "case",
  value: subject,
  arms: [{ constructor: "Red", binders: [], body: surface.integer(1) }],
  otherwise: { binder: "other", body: surface.integer(0) },
});
```

`at` stamps only the outermost node of a fold or desugaring — attributing a source range to a node
the builder synthesized would be a wrong location, which is worse than none. A `case` default needs
at least one arm naming a declared constructor, since that is how the owning type is found. `let`,
`if`, `case`, and `let-rec-group` have no builder yet; frontends write those node literals directly.

Traps do not need a host capability. `surface.runtimeFault(message)` is a first-class node that
infers as a fresh variable, so it typechecks wherever a diverging expression belongs.

`F32x4` is name-based: build it with `functionalF32x4`, splice in
`FUNCTIONAL_FIXED_VECTOR_TYPE_DECLARATIONS` and `FUNCTIONAL_FIXED_VECTOR_DEFINITIONS`, and compile
with `{ simd: "wasm-simd" }` to get native `v128` instructions. A frontend that declares its own
four-field vector type instead gets scalar-correct results and no SIMD.

The module's evaluation profile defaults to `StrictEager`; a Haskell-like frontend selects
`LazyCallByNeed`, and individual binding boundaries can override it. That choice is recorded in
resolved Core and controls implicit evaluation. Explicit laziness is separate: `surface.delay()`
creates a typed `Thunk value` and `surface.force()` evaluates it at most once.

Annotations are optional. The inference profile is Hindley–Milner with mutually recursive SCCs,
GADT-style indexed constructor results, and explicitly annotated predicative rank-N function
parameters. It is not dependent or impredicative, and the entry must resolve to a concrete
first-order boundary type.

One thing the docs previously got wrong, and worth knowing when reading a profile: **name resolution
runs on the host**, not the GPU. `src/semantic/symbol_lookup.ts` computes de Bruijn depths, global
and constructor resolution, and case-arm resolution as a lowering plan; the shader copies it. The
GPU owns inference — SCC discovery, unification, generalization, subsumption, indexed refinement,
coverage, and entry concreteness.

## Diagnostics and limits

Expected failures are structured: `F1xxx` for structural and resolution diagnostics and `F2xxx` for
type, annotation, and coverage diagnostics in the compile result; `F3001`–`F3012` as evaluation
faults, from either runtime; `F4001`–`F4007` as `FunctionalLinkError`. WebGPU setup and device
failures throw or reject with a `cause`, and options a chosen runtime cannot honour throw a
`TypeError`. Spans are UTF-8 byte offsets; `locateFunctionalDiagnostic()` maps an offset in a linked
module back to the owning module, and filenames, line/column lookup, and wording stay in the
frontend.

Source is capped at 1 MiB, surface trees at 65,536 nodes, semantic depth at 512, constructor arity
at 256, and stores at 16,777,216 elements. Compilation defaults to 1,000,000 semantic transitions
with a hard cap of 10,000,000, and bounded WebAssembly execution accepts at most 1,000,000 semantic
steps. Budgets and device limits fail with structured evidence rather than permitting unbounded GPU
work.

## Included frontends

Repository examples that exercise the public target. They demonstrate lowering techniques, not
compatibility with their source languages.

| Frontend                                            | Boundary demonstrated                                          |
| --------------------------------------------------- | -------------------------------------------------------------- |
| [Lazuli](examples/lazuli/)                          | Reference syntax, indexed proofs, host values, and laziness    |
| [Gleam](examples/gleam-functional/README.md)        | Strict inference, module linking, and pinned stdlib coverage   |
| [JavaScript AOT](examples/javascript-aot/README.md) | Baba parsing, control flow, lexical exceptions, and strict f64 |

## Documentation

- [BASELINE.md](BASELINE.md) — the measured performance record every claim is judged against.
- [ARCHITECTURE.md](ARCHITECTURE.md) — stage boundaries, the GPU machines, the retarget plan, and
  the decision record.
- [DEVELOPMENT.md](DEVELOPMENT.md) — setup, generated files, tests, benchmarks, and publishing.
- [CHANGELOG.md](CHANGELOG.md) — public release changes.

## License

MIT. See [LICENSE](LICENSE).
