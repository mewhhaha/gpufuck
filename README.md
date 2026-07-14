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

Run independent Lazuli programs in one GPU evaluation batch. The JSON output preserves the input
path order; each entry contains either a value or a runtime fault.

```sh
deno task run:lazuli-batch examples/lazuli/answer.lz examples/lazuli/list.lz
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

### Current syntax

- declarations: `let name = expression;`, arrow closures such as `value => value + 1`, and the
  compatible zero-or-one-parameter `fn name parameter = expression;` form;
- compile-time specialization: `const answer = 42;` and templates such as
  `const identity[T] = value => value;`, instantiated with `identity[Int]`;
- data: `data Type a = Constructor | Constructor(field: a, ...);` (the `List`, `Bytes`, and `Text`
  types and their constructors are built in);
- types: `Int`, `Bool`, `()`, tuples, right-associative functions, and Hindley–Milner
  let-polymorphism; top-level lets may carry annotations such as `let main : Int = 42;`;
- literals: `i32` integers, `true`/`false`, lazy lists such as `[1, 2]`, named constructor records
  such as `Line { quantity: 2, price: 21 }`, and UTF-8 text such as `"zażółć"`;
- functions: every function accepts one argument; application is juxtaposition and associates left,
  so `f x y` means `(f x) y`;
- tuples and unit: `f (a, b)` passes one tuple, `f ()` passes unit, and their case patterns are
  `| (a, b) -> expression` and `| () -> expression`;
- lazy bindings: `let name = value in body`;
- local recursion: `let rec name parameter = value in body`;
- conditionals: `if condition then consequent else alternate`;
- matching: `case value of | Constructor(bindings...) -> expression ... end`;
- operators: unary `-`; binary `*`, `/`, `+`, and `-`; comparisons, `==`, and `!=`.

Language keywords are reserved and cannot be used as declaration, parameter, binder, or field names.

Arithmetic is wrapping signed `i32`; division by zero is a structured runtime fault. Constructors
are first-class curried functions, their fields are lazy, and matching reuses the original field
thunks rather than copying or forcing them. For example, `Pair first second` is two unary
applications, while `consume (first, second)` is one application with a tuple.

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

## What runs where

The implementation keeps the boundary explicit:

1. The checked-in Baba/Wasm parser reads source on the host and produces a bounded, flat surface
   tree with interned symbols and UTF-8 byte spans.
2. A persistent WGSL compiler validates uploaded runtime tables, resolves lexical names to de Bruijn
   depths, resolves globals and constructors, validates patterns, and emits the core IR.
3. A second persistent WGSL phase validates flattened type schemas, discovers definition SCCs,
   performs Hindley–Milner inference, checks case coverage, and serializes the concrete `main` type.
4. Core nodes, definitions, and constructor metadata remain in GPU buffers.
5. A lane-aware WGSL abstract machine evaluates independent modules in parallel with explicit,
   disjoint heap and continuation-stack regions. Guest recursion never uses recursive WGSL calls.
6. Evaluation yields at bounded transition quanta and resumes from GPU-resident state. Only the
   compact lane state records are read back between dispatches.

Parsing remains host-side; semantic resolution, type inference, core lowering, and evaluation are
GPU-side. Compiler and scalar evaluator state stays GPU-resident between bounded dispatch quanta;
heterogeneous batches evaluate independent programs in separate regions.

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
  const compilation = await compiler.compile("let main = value => value + 1;");
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

## Development

```sh
deno task check
deno task fmt
deno task lint
deno task test
```

Measure steady-state, end-to-end Lazuli compilation time after compiler and device setup:

```sh
deno task bench:lazuli
```

The benchmark covers fixed small, recursive, algebraic-data-type, and 64-definition programs. Module
destruction is excluded from each timing sample. Use `deno task bench:lazuli --json` when capturing
machine-readable results for comparisons.

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
- The serial GPU compiler has a default budget of 1,000,000 persistent compiler transitions and
  returns `L1003` when that fuel is exhausted.
- The language uses Hindley–Milner inference with algebraic data types. Primitive operand errors,
  constructor mismatches, and non-exhaustive cases are compile diagnostics.
- Pattern fields are flat binders; nested destructuring is expressed with a nested `case`.
- Structured constructor results report only their outer constructor by default; opt-in deep results
  force and serialize fields within `maximumResultNodes`.
- A run has bounded fuel, heap, and continuation stack. It has no in-run collector or free list.
- GPU compilation is serial within one module but resumes from GPU-resident state; evaluation can
  batch heterogeneous modules in independent runtime regions.

## Brainfuck IR

The Brainfuck path uploads UTF-8 source and emits one 8-byte `{ opcode: u32, operand: u32 }` record
per source byte. Ignored bytes become `NOP`, and loop operands are absolute next-program-counter
targets. The IR remains GPU-resident until `readInstructions()` is explicitly requested, and its
owner must be destroyed when finished.
