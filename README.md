# gpufuck

A compiler backend that runs name resolution and Hindley–Milner type inference on the GPU, and emits
WebAssembly.

You bring a language: a parser, your own source-language rules, and a desugaring step. gpufuck takes
it from there — it typechecks, and it produces something you can run.

```text
your parser  ──►  Surface  ──►  [ GPU: resolve + infer ]  ──►  Core  ──┬──►  GPU evaluator
                 (you build)                                           └──►  WebAssembly
```

The point of the project is the middle box. Whether putting a typechecker on a GPU is a good idea is
an open question, and [BASELINE.md](BASELINE.md) is the honest running answer: **it depends entirely
on your workload**, and the numbers are in [Is it fast?](#is-it-fast) below.

## Install

```sh
deno add jsr:@mewhhaha/gpufuck
```

You need Deno 2.9+, a WebGPU adapter, and the unstable WebGPU flag in your `deno.json`:

```json
{
  "unstable": ["webgpu"]
}
```

There is no CPU fallback. `requestWebGpuDevice()` throws with setup evidence if WebGPU is disabled,
adapter discovery fails, or no adapter exists. A software adapter is fine for correctness but tells
you nothing about speed.

## Quickstart

This builds `main = 40 + 2`, typechecks it on the GPU, evaluates it, and emits a Wasm binary. It
runs as written:

```ts
import {
  BinaryOperator,
  buildSurfaceModule,
  compileModuleToWasm,
  EvaluationProfile,
  GpuCompiler,
  GpuEvaluator,
  requestWebGpuDevice,
  surface,
} from "@mewhhaha/gpufuck";

const source = "main = 40 + 2";

// 1. Build a Surface module. Normally your frontend emits this from a parse tree.
const module = buildSurfaceModule(
  [{
    name: "main",
    parameters: [],
    annotation: null, // types are inferred
    body: surface.binary(BinaryOperator.Add, surface.integer(40), surface.integer(2)),
  }],
  [], // no type declarations
  "main", // entry point
  new TextEncoder().encode(source).byteLength,
  { evaluationProfile: EvaluationProfile.StrictEager },
);

const device = await requestWebGpuDevice();
try {
  // 2. Resolve and typecheck on the GPU.
  const compiler = await GpuCompiler.create(device);
  const compilation = await compiler.compileModule(module);
  if (!compilation.ok) {
    const [first] = compilation.diagnostics;
    throw new Error(`${first.code}: ${first.message}`);
  }

  try {
    // 3a. Run it directly...
    const evaluator = await GpuEvaluator.create(device);
    const execution = await evaluator.evaluate(compilation.module);
    if (!execution.ok) throw new Error(`faulted: ${execution.fault.code}`);
    console.log(execution.value); // { kind: "integer", value: 42 }

    // 3b. ...or emit WebAssembly.
    const wasm = await compileModuleToWasm(compilation.module);
    console.log(wasm.byteLength); // 37
  } finally {
    compilation.module.destroy(); // owns GPU buffers
  }
} finally {
  device.destroy();
}
```

Three rules that will save you time:

- **Use `FunctionalCompilerService` for ordinary compilation.** It uses the CPU for HM modules and
  initializes one resident GPU compiler only when a GPU-only typechecking profile requires it. It
  also reuses an unchanged encoded module.
- **Use `GleamFrontendService` for a long-lived Gleam project.** It reuses unchanged parses and
  lowerings; an identical project returns the same packed module.
- **Use `ParallelGleamProjectFrontend` for a cold project with at least four modules.** It parses,
  collects public signatures, and lowers modules in resident workers before linking them in source
  order.
- **Use `ParallelGleamCompiler` for independent Gleam entries.** It keeps parsing, lowering,
  semantic compilation, and Wasm emission in the same worker and returns results in input order.
- **Use `ParallelFunctionalCompilerService` for independent packed modules.** It can compile Core,
  emit separate Wasm artifacts concurrently, or assemble one deterministic shared-runtime artifact.
- **`destroy()` a successful module in `finally`.** CPU modules make this a no-op; GPU modules
  release their buffers.
- **Use `compileModulesToWasm()` for independent entries that should share one artifact.**

## Is it fast?

No. Against Gleam 1.17.0 on the same source, on a Ryzen 7 7800X3D with an RTX 4080 SUPER:

| Workload                                     | Reproduce                      | Result           |
| -------------------------------------------- | ------------------------------ | ---------------- |
| **One large module**, compiled once          | `deno task bench:gleam-stdlib` | **5.75× slower** |
| **One source-only edit**                     | `deno task bench:gleam-stdlib` | **~6.0× slower** |
| **Unchanged large module**                   | `deno task bench:gleam-stdlib` | **~143× faster** |
| **1,024 modules**, shared Wasm artifact      | `deno task bench:gleam-batch`  | **~1.7× slower** |
| **1,024 independent modules**, fused workers | `deno task bench:gleam-batch`  | **~1.5× faster** |

The earlier batch claim charged Gleam one process and package startup for every module while gpufuck
used one resident process. The benchmark now gives both compilers all modules in one process and
includes executable output on both sides. `CpuCompiler` and the default compiler service avoid
WebGPU startup, but frontend work and Wasm emission still leave the full compiler behind.

On the standard-library corpus, the median of three benchmark medians is 118.5 ms to parse and
lower, 43.6 ms for host resolution, inference, and effects, and 107.7 ms for uncached Wasm emission.
The resulting 276.2 ms is 5.75× Gleam's 48.0 ms cold build. The raw HM phase is 14.0 ms; sharing
closed global environments removed its former quadratic top-level copying.

Independent compilation now breaks even between 512 and 1,024 modules. Across three complete
benchmark processes, the 1,024-module median was 264.6 ms for the fused source-to-Wasm worker path
and 407.0 ms for Gleam: gpufuck was 1.54× faster. Keeping the shared runtime changes the tradeoff:
the 1,024-module artifact is 2.03 MiB instead of 3.07 MiB, but monolithic Wasm emission remains
serial and the complete shared-artifact path is about 1.7× slower than Gleam.

The warm result has two distinct meanings. An unchanged project takes about 0.075 ms because all
three stages reuse immutable results, versus Gleam's 10.7 ms no-change build. A source-only edit
takes 71.1 ms versus Gleam's 11.7 ms because gpufuck still relinks and recompiles the complete Core.
Incremental semantic compilation and function-granular Wasm reuse, not HM inference, are now the
remaining edited-build bottlenecks. [BASELINE.md](BASELINE.md) records the raw measurements and
superseded claims; [TASKS.md](TASKS.md) ranks what is left.

**Does it produce correct code?** 547 of Gleam's own 1,521 standard-library tests compile to
WebAssembly and pass upstream's assertions — 97% of those needing no JavaScript FFI adapter. Run it
with `deno task check:gleam-stdlib-wasm <stdlib-checkout>`.

## Building a frontend

Your frontend does the language-specific work: parse, enforce your own rules, then desugar into the
handful of things Core knows about — functions, immutable bindings, application, conditionals,
constructors, and `case`. Lists, records, traits, and source modules are **not** Core primitives;
you lower them (traits become explicit dictionaries, records become constructors, and so on).

You also convert your nominal declarations and annotations into `TypeSchema` values, attach UTF-8
byte spans, and translate the neutral diagnostics back into your own terminology.

`buildSurfaceModule()` does the mechanical part: interning names, currying multi-parameter
definitions, installing the reserved unit and pair constructors, and packing the ABI. Multiple
parameters become nested unary lambdas, calls become left-associated `apply` nodes, and nested
patterns become nested flat `case` expressions. `linkModules()` combines several `ModuleArtifact`
values into one program before compilation, qualifying names and checking typed imports against
exports.

### The surface builder

`surface` covers literals, `name`, `lambda`, `apply`, `let`, `if`, `case`, `binary`, `unary`,
`convert`, `equal`, `structuralEqual`, `delay`, `force`, `store*`, and `runtimeFault`. Several
helpers exist because two unrelated frontends independently hand-rolled the same workaround:

```ts
// Spans: `at` stamps every node its helpers produce.
const at = surface.at({ startByte: 42, endByte: 47 });
at.binary(BinaryOperator.Add, at.integer(20), at.integer(22));

// Parameter lists fold right, so you do not curry by hand.
surface.lambda(["x", "y"], surface.name("y"));

// A case default: omitted arms are filled in, and the fallback binds once.
surface.case(
  subject,
  [{ constructor: "Red", binders: [], body: surface.integer(1) }],
  { binder: "other", body: surface.integer(0) },
);
```

`at` stamps the interior spine too, not just the outermost node: on `lambda(["x", "y"], body)` each
curried lambda carries the span, and on `apply(callee, a, b)` each application node does. Stamping
only the outside would silently drop one span per parameter and per extra argument — spans you would
have kept writing the node literals by hand. `case` arms and the `otherwise` default carry their own
optional spans, so `at` fills in only the blanks rather than overwriting a more precise arm span. A
`case` default needs at least one arm naming a declared constructor, since that is how the owning
type is found. `let-rec-group` is the only node kind with no builder.

Traps need no host capability: `surface.runtimeFault(message)` is a first-class node that infers as
a fresh variable, so it typechecks wherever a diverging expression belongs.

### Effects

Source effect operations are typed functions whose effect labels travel with the callable value:

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

Calling `tick` adds `Clock.Tick` to the enclosing definition's effect summary. Passing it to another
function carries the same label through the higher-order call. Pure code is the empty set,
`effectSet()`, and effect sets support `union`, `intersection`, `difference`, and
`symmetricDifference`.

Handlers are ordinary lexical evidence. `surface.withEffectHandler("tick", implementation, body)`
binds a replacement operation within `body`; a pure replacement discharges `Clock.Tick`, including
when that binding is passed through higher-order code. Nesting handlers removes only the labels
whose operation bindings they replace. This is lexical substitution, not dynamic interception: a
function defined elsewhere that already refers to the global `tick` remains effectful when called
inside the handler. Pass the operation into that function explicitly, or inline its body, when the
replacement must reach it. Compilation exposes the original declarations through
`GpuModule.declaredDefinitionEffects` and the inferred fixed point through `definitionEffects`,
`entryEffects`, and each WebAssembly export's `effects`.

Immutable effect sets are not structured-cloneable. Send an encoded module through a Worker with
`encodeModuleForTransfer()`, then restore it with `decodeTransferredModule()` before compilation.

This evidence-passing path handles ordinary operation replacement. Abortive control has a smaller
future Core design described in [ARCHITECTURE.md](ARCHITECTURE.md#abortive-control-boundary), but is
not implemented. Full resumable and multi-shot handlers remain a separate continuation project.

`F32x4` is name-based. Build it with `f32x4`, splice in `FIXED_VECTOR_TYPE_DECLARATIONS` and
`FIXED_VECTOR_DEFINITIONS`, and compile with `{ simd: "wasm-simd" }` for native `v128` instructions.
Declaring your own four-field vector type instead gets you scalar-correct results and no SIMD.

### Typing

Annotations are optional. Inference is Hindley–Milner with mutually recursive SCCs, GADT-style
indexed constructor results, and explicitly annotated predicative rank-N function parameters. It is
not dependent or impredicative, and your entry must resolve to a concrete first-order boundary type.

Evaluation profile defaults to `StrictEager`; a Haskell-like frontend selects `LazyCallByNeed`, and
individual binding boundaries can override it. Explicit laziness is separate: `surface.delay()`
creates a typed `Thunk value` and `surface.force()` evaluates it at most once.

Worth knowing when reading a profile: **name resolution runs on the host**, not the GPU.
`src/semantic/symbol_lookup.ts` computes de Bruijn depths and global, constructor, and case-arm
resolution as a lowering plan; the shader copies it. The GPU owns inference — SCC discovery,
unification, generalization, subsumption, indexed refinement, coverage, and entry concreteness.

## Running your program

Two runtimes, and the choice is mostly not yours to make.

Portable WGSL has no `i64` or `f64` and does not promise host-Wasm rounding, so the GPU evaluator
cannot execute 64-bit floats, portable whole-number f64, text, bytes, runtime faults, buffer append,
`Store` operations, structural equality, f32 division, or f32 square root. `GpuEvaluator.evaluate`
inspects resolved Core before dispatch and delegates any program using them to bounded WebAssembly,
so you do not pass a flag. That delegated path accepts `maximumSteps` and result limits but rejects
GPU-specific dispatch, heap, and stack options with a `TypeError`.

A module declaring host capabilities must go through `runWasmModule` instead, because that is where
the runner `init` is supplied:

```ts
import { compileModuleToWasm, runWasmModule } from "@mewhhaha/gpufuck";

const bytes = await compileModuleToWasm(compilation.module);
await Deno.writeFile("main.wasm", bytes);

const execution = await runWasmModule(compilation.module);
```

Host capability declarations and `wasmExports` are consumed here: capabilities become the imported
host boundary supplied through the run options' `init`, and exported definitions become module
exports.

## Diagnostics and limits

Expected failures are structured, in one `F####` namespace:

| Range                    | Meaning                                          |
| ------------------------ | ------------------------------------------------ |
| `F1001`–`F1003`          | structural and resolution diagnostics            |
| `F2001`–`F2104`          | type, annotation, and coverage diagnostics       |
| `F3001`–`F3012`          | evaluation faults, from either runtime           |
| `F3013`, `F3101`–`F3104` | evaluation faults only bounded Wasm can raise    |
| `F4001`–`F4007`          | `LinkError` from `linkModules()`                 |
| `F4101`–`F4102`          | host boundary, including a missing runner `init` |
| `F5001`–`F5002`          | comptime execution                               |
| `F6001`–`F6006`          | Storage Core verification                        |

WebGPU setup and device failures throw or reject with a `cause`. Options a chosen runtime cannot
honour throw a `TypeError`. Spans are UTF-8 byte offsets; `locateDiagnostic()` maps an offset in a
linked module back to the owning module. Filenames, line/column lookup, and wording stay in your
frontend.

## Worked examples

Three frontends live in the repository. They are samples rather than API — they are not in the
published package, and you should read them rather than import them.

| Frontend                                            | What it demonstrates                                           |
| --------------------------------------------------- | -------------------------------------------------------------- |
| [Gleam](examples/gleam/README.md)                   | Strict inference, module linking, pinned stdlib coverage       |
| [Lazuli](examples/lazuli/)                          | Reference syntax, indexed proofs, host values, and laziness    |
| [Sweep](examples/sweep/README.md)                   | A language shaped by [DESIGN.md](DESIGN.md); no inference      |
| [JavaScript AOT](examples/javascript-aot/README.md) | Baba parsing, control flow, lexical exceptions, and strict f64 |

Gleam is the most complete and the one the benchmarks use; drive it with `deno task run:gleam`.

[Ducklang](ARCHITECTURE.md#7-external-consumers) is the real out-of-repo consumer. It compiles
through the WebAssembly backend and has no other code generator.

## Where to go next

| Document                           | What it is                                                      |
| ---------------------------------- | --------------------------------------------------------------- |
| [TASKS.md](TASKS.md)               | Ranked future work, each item with the measurement behind it    |
| [CHALLENGES.md](CHALLENGES.md)     | Degenerate cases and hard walls: what breaks, why, and options  |
| [DESIGN.md](DESIGN.md)             | Sketch: what a language designed for this pipeline would be     |
| [BASELINE.md](BASELINE.md)         | Every performance claim, how it was measured, and what failed   |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Implementation boundaries and why they are where they are       |
| [DEVELOPMENT.md](DEVELOPMENT.md)   | Contributing: the verification loop, test ownership, publishing |
| [CHANGELOG.md](CHANGELOG.md)       | Release history                                                 |

## Status

This is a research project, published so it can be depended on, not because it is finished. The API
changed comprehensively in 0.4.0 and may change again. It is pre-1.0 and the version reflects that.

What is solid: the ABI, the diagnostics, the two execution paths, and the measurements. What is not:
single-module compile latency, and the assumption that a GPU is the right place for type inference —
which the project exists to test, and has not yet answered in the affirmative.

## License

MIT. See [LICENSE](LICENSE).
