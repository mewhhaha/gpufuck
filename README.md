# GPU functional compiler

The goal of this repository is a reusable compiler backend that functional-language frontends can
target. A frontend owns its syntax and desugaring, emits a bounded language-neutral functional
module, and hands that module to persistent GPU passes for validation, name resolution, type
inference, core lowering, and execution.

Lazuli is the current reference frontend used to develop and test that backend. Its lazy semantics,
algebraic data, polymorphism, indexed constructor results, and evaluator exercise the reusable
functional core; they are not intended to define the final compiler API. The original Brainfuck
compiler is a separate historical prototype and is not part of the functional backend contract.

The public `GpuFunctionalCompiler.compileModule()` entry point accepts that portable module
directly. It does not import or load the Baba parser. `GpuLazuliCompiler` is now a compatibility
frontend that parses, desugars, adds explicit profile metadata, and delegates to the same entry
point.

## Run the reference frontend

Requirements:

- Deno 2.9 or newer;
- a WebGPU adapter available to Deno.

Direct API use also needs read permission because the frontend loads the checked-in Baba parser
assets. The tasks below already grant it.

Run a Lazuli program:

```sh
deno task run:lazuli examples/lazuli/list.lz
```

Install Lazuli syntax highlighting and rainbow brackets for `.lz` files in Helix:

```sh
just install
```

The install regenerates the Baba syntax artifacts, builds a native Tree-sitter parser, and updates
only the Lazuli-managed block in the Helix user language configuration.

Run independent Lazuli programs in one GPU evaluation batch. The JSON output preserves the input
path order; each entry contains either a value or a runtime fault.

```sh
deno task run:lazuli-batch examples/lazuli/answer.lz examples/lazuli/list.lz
```

Compile Lazuli and inspect the GPU-produced core IR:

```sh
deno task compile:lazuli examples/lazuli/local-rec.lz
```

Run equality proofs and typed facts checked by GPU inference:

```sh
deno task run:lazuli examples/lazuli/proofs.lz
```

Other useful examples:

```sh
deno task run:lazuli examples/lazuli/syntax-tour.lz
deno task run:lazuli examples/lazuli/option-map.lz
deno task run:lazuli examples/lazuli/collections.lz
deno task run:lazuli examples/lazuli/answer.lz
deno task run:lazuli examples/lazuli/lazy.lz
deno task run:lazuli examples/lazuli/closure.lz
deno task run:lazuli examples/lazuli/factorial.lz
deno task run:lazuli examples/lazuli/constructor.lz
```

The historical Brainfuck prototype remains available independently:

```sh
deno task compile examples/nested.bf
```

## Frontend contract

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

Language neutrality also applies to semantics. The current implementation provides a lazy,
Hindley–Milner-plus-indexed-types profile. A strict frontend will need either an explicit strictness
profile or forcing constructs in its lowering; a language with its own type system should be able to
submit a pretyped module for GPU verification instead of being forced through HM inference. Effects
and module systems can be lowered into explicit core values and operations rather than becoming
parser-specific backend branches.

The functional API does not assume Lazuli keywords, its Baba parser, or its source diagnostic
prefix. Likewise, the Brainfuck instruction format is not a backend IR. ABI v5 currently accepts the
`lazy-call-by-need-v1` evaluation profile and `hindley-milner-indexed-v1` typechecking profile;
profile metadata is versioned so later strict or pretyped frontends do not silently receive the
wrong semantics.

## Compile-time Type Core

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

Capability discovery is deliberately separate from deterministic type execution.
`TypeCoreCapabilityResolver` indexes declarative rules by predicate, matches kinded structural
patterns, resolves prerequisites, and returns associated outputs plus an evidence tree. Witnesses
state whether a proof is erased, names a compile-time implementation, or requires a runtime
dictionary. `verify()` independently replays the rule tree, so cached or transported evidence need
not be trusted. Search has explicit transition and depth limits, reports overlap as ambiguity, and
requires every output and prerequisite variable to be determined by the rule inputs. Typical
predicates can describe `field(owner, name) -> fieldType`, `method(owner, name) -> implementation`,
or ordinary propositions such as `copy(type)`.

The current evaluator is a bounded lazy graph reducer, not an interaction-net implementation. The
public Type Core and evidence formats keep that implementation choice internal: a future local
interaction reducer can replace the lowering without making frontend IRs depend on ports, agents, or
rewrite scheduling. Capability search remains a distinct operation because proof selection may be
ambiguous even when type normalization must be deterministic.

## Lazuli reference frontend

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
- data: `data Type a = Constructor | Constructor(field: a, ...);`; a constructor may declare an
  indexed result such as `data Equal a b = Refl : Equal a a;`, while empty types use
  `data Impossible = ;` (the `List`, `Bytes`, and `Text` types and their constructors are built in);
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
- matching: `case value of | Constructor(bindings...) -> expression ... end`; a zero-arm
  `case impossible of end` is valid when the known scrutinee type has no compatible constructors;
- operators: unary `-`; binary `*`, `/`, `+`, and `-`; comparisons, `==`, and `!=`.

Language keywords are reserved and cannot be used as declaration, parameter, binder, or field names.

Arithmetic is wrapping signed `i32`; division by zero is a structured runtime fault. Constructors
are first-class curried functions, their fields are lazy, and matching reuses the original field
thunks rather than copying or forcing them. For example, `Pair first second` is two unary
applications, while `consume (first, second)` is one application with a tuple. Every type parameter
used by an indexed constructor field must also be a bare, direct argument of that constructor's
result type.

### Proofs and typed facts

Indexed constructor results let ordinary Lazuli values carry type evidence. A small logical core is
already expressible from existing language forms:

- `()` witnesses truth;
- an empty data declaration such as `data False = ;` represents falsehood;
- `(a, b)` represents conjunction and `a -> b` represents implication;
- a two-constructor data declaration represents disjunction;
- `data Equal a b = Refl : Equal a a;` represents type equality.

Matching an equality witness introduces a scoped type fact, so an annotated function can safely
return a value at the refined type. Constructors whose result cannot match the scrutinee type are
excluded from coverage, allowing an impossible indexed type to use a zero-arm case. The GPU checks
these refinements during inference; facts never escape the case arm that introduced them.

```lazuli
data Equal a b = Refl : Equal a a;

let cast : Equal a b -> a -> b = proof => value =>
  case proof of
    | Refl -> value
  end;
```

Proof witnesses are ordinary lazy runtime values. Lazuli does not erase them or claim proof
normalization, which matters because recursive programs can diverge. See
[`examples/lazuli/proofs.lz`](examples/lazuli/proofs.lz) for equality composition, false
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
5. Core nodes, definitions, constructor metadata, and active compiler state remain in GPU buffers.
6. A lane-aware WGSL abstract machine evaluates independent modules in parallel with explicit,
   disjoint heap and continuation-stack regions. Guest recursion never uses recursive WGSL calls.
7. Compilation and evaluation yield at bounded transition quanta and resume from GPU-resident state.
   Compact state records are read back between dispatches; full results are read only at completion
   or when formatting a diagnostic.

The TypeScript inference implementation is a differential-test oracle, not a production fallback.
Parsing, syntax-specific desugaring, and structural schema packing remain host-side; semantic
resolution, type inference, core lowering, and evaluation are GPU-side.

## Bounded work, latency, and batching

Every charged compiler transition performs constant-bounded work: it inspects one logical record or
edge, pushes at most two durable frames, and allocates at most one record in each arena.
Unification, occurs checks, generalization, instantiation, indexed coverage, SCC walking, and output
serialization all resume from GPU-resident frames. Fuel therefore bounds semantic work, while
cancellation can be observed between dispatches.

The default dispatch quantum is 4,096 transitions. Setting `maximumStepsPerDispatch: 1` is useful
for deterministic fuel, cancellation, and workspace-growth tests, but it intentionally turns every
semantic transition into a separate GPU submission and mapped readback. Those tests can take seconds
even when a normal steady-state compilation takes milliseconds.

Independent `compileModule()` and compatibility `compile()` calls share a resource-weighted
admission queue per compiler and can be coalesced into GPU dispatch batches. A single module still
advances through its own ordered transition machine; batching improves throughput rather than
changing its semantics. Use `deno task bench:lazuli` for measurements on the active WebGPU adapter.

## Memory and ownership

Lazuli source values are immutable. The runtime internally updates thunk records to implement
call-by-need sharing.

Each evaluation owns a bounded bump-allocated region for thunks, environments, closures,
constructors, and recursive cycles. Its buffers are destroyed in `finally`, reclaiming the entire
region in constant time without a tracing collector or a background GC process. Memory is not reused
inside one run yet; a program that exceeds its configured region returns `L3003` rather than
accessing outside a GPU buffer.

Type inference starts with input-derived arena capacities. If one arena fills, only that region is
doubled; live logical records are copied into a replacement workspace and inference resumes without
resetting its phase, fuel, refinements, or results. Device and allocation limits produce an
evidence-rich `L1003`, and failed or cancelled growth destroys both temporary workspaces.

A successful compilation owns its GPU module buffers. Call `module.destroy()` when finished;
destruction is idempotent. Evaluations borrow the module and automatically release only their own
temporary region and stack buffers.

## Functional module API

The smallest module below is assembled without a parser or Lazuli source. A real frontend interns
its own names and packs the same record tables while lowering its AST.

```ts
import {
  FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  FUNCTIONAL_MODULE_ABI_VERSION,
  FUNCTIONAL_NO_INDEX,
  FunctionalEvaluationProfile,
  FunctionalExpressionTag,
  FunctionalTypecheckingProfile,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
} from "./functional.ts";

const encodedModule = {
  abiVersion: FUNCTIONAL_MODULE_ABI_VERSION,
  sourceByteLength: 2,
  evaluationProfile: FunctionalEvaluationProfile.LazyCallByNeed,
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
    console.log(await evaluator.evaluate(compilation.module));
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
and UTF-8 byte spans; runtime faults use `F3001`–`F3011`.

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
| `LetRec`       | bound symbol               | parameter lambda     | body                  | —         |
| `If`           | `0`                        | condition            | consequent            | alternate |
| `Lambda`       | parameter symbol           | body                 | —                     | —         |
| `Apply`        | `0`                        | callee               | argument              | —         |
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

`GpuFunctionalEvaluator` accepts integers, Booleans, unit, pairs, and recursively nested declared
constructors. It deliberately has no `Text` or `List` name convention: a frontend represents those
through its own algebraic declarations and constructor inputs. Weak-head and bounded deep results,
batching, fuel, heap, stack, and cancellation behave the same as the reference frontend.

## Lazuli compatibility API

This source-oriented wrapper parses Lazuli and invokes the functional module API. Its existing
types, diagnostics, text/list conveniences, and `mainType` property remain compatible.

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

## Backend boundary

The parser-independent boundary is implemented:

1. Neutral module, schema, diagnostic, compiled-module, evaluator, and value types are public.
2. Entry symbol, primitive capabilities, evaluation strategy, and typechecking mode are explicit.
3. `compileModule()` accepts encoded modules without importing or loading a parser.
4. Lazuli is a thin parse/desugar adapter with its original API and diagnostic codes preserved.
5. The neutral evaluator treats declared constructors literally; Lazuli-only text/list host sugar is
   enabled only through the compatibility evaluator.
6. Brainfuck remains outside the functional package and contract.

The WGSL kernels and several internal implementation files retain legacy Lazuli names while they are
moved mechanically behind the neutral package. They consume only the encoded functional tables on
the generic path; no parser state or Lazuli source syntax crosses the boundary.

## Development

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

- Source is capped at 1 MiB, surface trees at 65,536 nodes, semantic depth at 512, and constructor
  arity at 64. Extremely deep concrete syntax can reach the generated parser's stack-safe limit
  sooner and returns `L1003`.
- Compilation has a default budget of 1,000,000 persistent semantic transitions and returns `L1003`
  when that fuel is exhausted.
- The current functional core uses Hindley–Milner inference with GADT-style indexed constructor
  results, not full dependent types. Indexed elimination needs a fully known expected and scrutinee
  type; a recursive top-level definition needs an explicit annotation, and local recursive
  definitions cannot perform indexed elimination because the core has no local recursive signature
  record.
- Every type parameter used by an indexed constructor field must be a bare, direct argument of that
  constructor's result. Existential field recovery is not implemented.
- Proof witnesses are runtime values and are not erased. Primitive operand errors, constructor
  mismatches, inaccessible arms, and non-exhaustive cases are compile diagnostics.
- Pattern fields are flat binders; nested destructuring is expressed with a nested `case`.
- Structured constructor results report only their outer constructor by default; opt-in deep results
  force and serialize fields within `maximumResultNodes`.
- A run has bounded fuel, heap, and continuation stack. It has no in-run collector or free list.
- GPU compilation is ordered within one module but concurrent modules are admitted by estimated
  transient memory and coalesced into dispatch batches. Evaluation can batch heterogeneous modules
  in independent runtime regions.

## Historical Brainfuck prototype

The Brainfuck path uploads UTF-8 source and emits one 8-byte `{ opcode: u32, operand: u32 }` record
per source byte. Ignored bytes become `NOP`, and loop operands are absolute next-program-counter
targets. The IR remains GPU-resident until `readInstructions()` is explicitly requested, and its
owner must be destroyed when finished. It shares low-level WebGPU setup with the repository but is
not an input, IR, or compatibility requirement of the functional compiler backend.
