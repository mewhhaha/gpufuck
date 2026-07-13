# gpufuck and Lazuli

This repository contains two small compilers for Deno WebGPU:

- the original Brainfuck-to-IR GPU compiler;
- Lazuli, a lazy, immutable functional language whose name resolution and core lowering run on the
  GPU, followed by a GPU-resident call-by-need evaluator.

Lazuli is now a general functional core rather than a single-expression demo. It has first-class
functions, lexical closures, lazy shared bindings, local and top-level recursion, algebraic data,
curried constructors, and pattern matching.

## Run it

Requirements:

- Deno 2.9 or newer;
- a WebGPU adapter available to Deno.

Direct API use also needs read permission because the frontend loads the checked-in Baba parser
assets. The tasks below already grant it.

Run a Lazuli program:

```sh
deno task run:lazuli examples/lazuli/list.lz
```

Compile Lazuli and inspect the GPU-produced core IR:

```sh
deno task compile:lazuli examples/lazuli/local-rec.lz
```

Other useful examples:

```sh
deno task run:lazuli examples/lazuli/answer.lz
deno task run:lazuli examples/lazuli/lazy.lz
deno task run:lazuli examples/lazuli/closure.lz
deno task run:lazuli examples/lazuli/factorial.lz
deno task run:lazuli examples/lazuli/constructor.lz
```

The original Brainfuck compiler is still available:

```sh
deno task compile examples/nested.bf
```

## Lazuli by example

```lazuli
data List = Nil | Cons(head, tail);

fn sum values =
  case values of
    | Nil -> 0
    | Cons(head, tail) -> head + sum(tail)
  end;

fn main = sum(Cons(20, Cons(22, Nil)));
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
    if n == 0 then 1 else n * factorial(n - 1)
  in
  factorial(6);
```

### Current syntax

- declarations: `fn name parameters... = expression;`
- data: `data Type = Constructor | Constructor(field, ...);`
- literals: `i32` integers (negative forms use unary `-`) and `true`/`false`;
- functions: `fun parameter -> expression` and curried calls such as `f(a)(b)`;
- lazy bindings: `let name = value in body`;
- local recursion: `let rec name parameter = value in body`;
- conditionals: `if condition then consequent else alternate`;
- matching: `case value of | Constructor(bindings...) -> expression ... end`;
- operators: unary `-`; binary `*`, `/`, `+`, and `-`; comparisons, `==`, and `!=`.

Language keywords are reserved and cannot be used as declaration, parameter, binder, or field names.

Arithmetic is wrapping signed `i32`; division by zero is a structured runtime fault. Constructors
are first-class curried functions, their fields are lazy, and matching reuses the original field
thunks rather than copying or forcing them.

## What runs where

The implementation keeps the boundary explicit:

1. The checked-in Baba/Wasm parser reads source on the host and produces a bounded, flat surface
   tree with interned symbols and UTF-8 byte spans.
2. One serial WGSL compiler invocation validates the uploaded tables, resolves lexical names to de
   Bruijn depths, resolves globals and constructors, validates patterns, and emits the core IR.
3. Core nodes, definitions, and constructor metadata remain in GPU buffers.
4. A serial WGSL abstract machine evaluates the module with explicit heap and continuation-stack
   indices. Guest recursion never uses recursive WGSL calls.
5. Evaluation yields at bounded transition quanta and resumes from GPU-resident state. Only the
   compact status/result record is read back between dispatches.

Parsing is therefore host-side; semantic compilation and evaluation are GPU-side. The serial
implementation is a correctness baseline, not a claim that one program has lower latency on a GPU
than on a CPU. The natural parallel extension is to evaluate many independent programs in separate
regions.

## Memory and ownership

Lazuli source values are immutable. The runtime internally updates thunk records to implement
call-by-need sharing.

Each evaluation owns a bounded bump-allocated region for thunks, environments, closures,
constructors, and recursive cycles. Its buffers are destroyed in `finally`, reclaiming the entire
region in constant time without a tracing collector or a background GC process. Memory is not reused
inside one run yet; a program that exceeds its configured region returns `L3003` rather than
accessing outside a GPU buffer.

A successful compilation owns its GPU module buffers. Call `module.destroy()` when finished;
destruction is idempotent. Evaluations borrow the module and automatically release only their own
temporary region and stack buffers.

## API

```ts
import { GpuLazuliCompiler, GpuLazuliEvaluator, requestWebGpuDevice } from "./mod.ts";

const device = await requestWebGpuDevice();
try {
  const compiler = await GpuLazuliCompiler.create(device);
  const compilation = await compiler.compile("fn main = 6 * 7;");
  if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);

  try {
    const evaluator = await GpuLazuliEvaluator.create(device);
    const result = await evaluator.evaluate(compilation.module, {
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

Compilation diagnostics use UTF-8 byte spans (`L1001`–`L2009`). Runtime faults cover invalid
modules, fuel, heap and stack limits, blackholes, dynamic type errors, division by zero, and
non-exhaustive cases (`L3001`–`L3008`).

## Development

```sh
deno task check
deno task fmt
deno task lint
deno task test
```

Regenerate the checked-in parser after changing `language/lazuli/grammar.baba`:

```sh
deno task generate:lazuli
```

The generator and runtime are pinned to `jsr:@mewhhaha/baba@4.0.0`. Generated assets are excluded
from `deno fmt` so regeneration remains byte-for-byte reproducible with that published generator.

## Deliberate limits

- Source is capped at 1 MiB, surface trees at 65,536 nodes, semantic depth at 512, and constructor
  arity at 64. Extremely deep concrete syntax can reach the generated parser's stack-safe limit
  sooner and returns `L1003`.
- The current serial GPU compiler rejects programs estimated to need more than 1,000,000 semantic
  loop iterations with `L1003`, avoiding WebGPU watchdog stalls until lookup is indexed or parallel.
- The language is dynamically typed; name, declaration, constructor, and pattern checks happen at
  compile time, while primitive operand errors are runtime faults.
- Pattern fields are flat binders; nested destructuring is expressed with a nested `case`.
- Structured constructor results report their outer constructor without forcing or serializing
  fields.
- A run has bounded fuel, heap, and continuation stack. It has no in-run collector or free list.
- GPU compilation is still one serial invocation; evaluation is resumable but not yet batched.

## Brainfuck IR

The Brainfuck path uploads UTF-8 source and emits one 8-byte `{ opcode: u32, operand: u32 }` record
per source byte. Ignored bytes become `NOP`, and loop operands are absolute next-program-counter
targets. The IR remains GPU-resident until `readInstructions()` is explicitly requested, and its
owner must be destroyed when finished.
