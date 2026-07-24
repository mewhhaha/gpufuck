# gpufuck

`gpufuck` exists to answer one question: can a compiler's semantic phases run fast on a GPU? A
language frontend supplies syntax, source-language rules, and desugaring; gpufuck packs that into a
portable Functional Surface, resolves and typechecks it on WebGPU, and produces a resolved
Functional Core. Core programs are executed by the GPU Core evaluator.

Everything that did not serve that question has been removed.

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
    ▼
GPU Core evaluator
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

**Execution lost capabilities.** The Wasm backend is gone, so the GPU evaluator is the only runtime.
It cannot execute 64-bit floats, portable whole-number f64, text, bytes, runtime faults, buffers,
stores, structural equality, f32 division, or f32 square root — WGSL does not offer portable
semantics for them, and there is no longer a Wasm path to delegate to.
`GpuFunctionalEvaluator.evaluate` inspects resolved Core and throws a `TypeError` naming the first
construct it cannot run. Such programs still compile and typecheck; they just cannot be evaluated.
This is a real, deliberate loss, not an oversight.

## Installation

Requires Deno 2.9 or newer, Deno's unstable WebGPU API, and a WebGPU adapter. There is no CPU
fallback: `requestWebGpuDevice()` throws with setup evidence when WebGPU is disabled, adapter
discovery fails, or no adapter is available. A software adapter works for correctness but does not
predict hardware latency.

```sh
deno add jsr:@mewhhaha/gpufuck@^0.3.0
```

```json
{
  "unstable": ["webgpu"]
}
```

Two entry points: the root is the complete language-neutral API, and `./core` is the same surface
and Core contracts plus GPU compilation, without the evaluator, linker, or trace renderer. The
bundled Lazuli, Gleam, and JavaScript AOT frontends are repository examples, not published exports.

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
faults; `F4001`–`F4007` as `FunctionalLinkError`. WebGPU setup and device failures throw or reject
with a `cause`, and Core the evaluator cannot execute throws a `TypeError` naming the construct.
Spans are UTF-8 byte offsets; `locateFunctionalDiagnostic()` maps an offset in a linked module back
to the owning module, and filenames, line/column lookup, and wording stay in the frontend.

Source is capped at 1 MiB, surface trees at 65,536 nodes, semantic depth at 512, constructor arity
at 256, and stores at 16,777,216 elements. Compilation defaults to 1,000,000 semantic transitions
with a hard cap of 10,000,000. Host capability and Wasm-export declarations still typecheck, but no
backend consumes them. Budgets and device limits fail with structured evidence rather than
permitting unbounded GPU work.

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
