# Primitive simplification research

Date: 2026-07-29. Gpufuck baseline: `86e112b`, package 0.6.0, Functional ABI 6. Duck baseline:
`d302fa5`. Blot baseline: `aacf778`.

## Decision

Keep ABI 6 and the production Core unchanged at this checkpoint.

Exact-arity functions/calls and packed case metadata survive the representation screen: across
twelve gpufuck programs they project 25.03% fewer executable nodes and 17.76% fewer packed words.
Duck examples project 0–13.33% fewer nodes and Blot's collections example projects 20.97% fewer.
This is enough to justify an executable ABI-7 prototype, but not enough to accept it for production:
the experiment did not replace the compiler, evaluator, and three Wasm/GPU paths, so it has no valid
runtime or compile-time A/B.

Reject the explicit-evaluation design. A direct `Delay`/`Force` translation grows representative
Lazuli from 1,237 to 2,145 nodes, or 73.4%, despite preserving sharing, unused faults, and blackhole
behavior in the experiment model.

Reject the current table-driven primop prototype. One table can cover all 93 operations and reduce
ten primitive tags to one, but 301 primitive-specific references remain across 24 production files.
That relocates the taxonomy without deleting its independent consumers.

Reject checking-only typed Core and new specialization/inlining in this pass. The checking kernel is
small and fast, but no frontend retains all required binder/type-application facts. The Wasm backend
already specializes direct calls and inlines sole calls; no A/B demonstrated another 5% runtime win.

## Worktrees and review branches

The experiment root is:

```text
/home/mewhhaha/src/primitive-simplification-experiments
  baseline/{gpufuck,binned,blot}
  structural/{gpufuck,binned,blot}
  evaluation/{gpufuck,binned,blot}
  primops/{gpufuck,binned,blot}
  typed/{gpufuck,binned,blot}
  wasm/{gpufuck,binned,blot}
  synthesis/{gpufuck,binned,blot}
```

Duck experiment import maps point at their sibling `../gpufuck/functional.ts`. The original gpufuck,
Duck, and Blot checkouts were not changed. These branches remain available:

| Branch                              | Commit    | Contents                                  |
| ----------------------------------- | --------- | ----------------------------------------- |
| `research/primitive-baseline`       | `af9ff44` | Reproducible corpus/tag counter           |
| `research/primitive-structural`     | `d225a73` | Exact-arity/case packing projection       |
| `research/primitive-evaluation`     | `4733b26` | `Delay`/`Force` semantic and size model   |
| `research/primitive-primops`        | `e874fce` | 93-entry declarative primop table         |
| `research/primitive-typed`          | `ff9f316` | Local System-F-style checking kernel      |
| `research/primitive-wasm`           | `ec5a327` | Wasm specialization workload measurements |
| `research/primitive-synthesis`      | `86c021d` | Structural plus primop synthesis          |
| `research/primitive-synthesis-duck` | `f6e79fd` | Duck 0.6 effect-contract adapter          |

No branch changes `MODULE_ABI_VERSION`, the package version, or production behavior.

## Consumer and primitive matrix

| Construct                      | Classification                | Consumers and reason                                                                     |
| ------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------- |
| Scalar/text/bytes literals     | Calculus value                | All frontends and all runtimes                                                           |
| Local/global references        | Calculus primitive            | Resolution, inference, evaluator, Wasm                                                   |
| Lambda/application             | Calculus primitive            | All frontends; currently unary                                                           |
| `let`/`let-rec`                | Calculus primitive            | Sharing, recursion, inference                                                            |
| Constructors                   | Calculus primitive            | Lazuli, Gleam, Sweep, Duck, Blot                                                         |
| `case`                         | Calculus primitive            | Nominal elimination and indexed refinement                                               |
| `CaseArm`/`PatternBind`        | Packed metadata candidate     | Currently executable nodes consumed by inference, evaluation, capture, and tail analysis |
| `if`                           | Control primitive             | Retain; constructor encoding has no measured win                                         |
| Unary/binary/conversion        | Primop candidate              | All strict numeric consumers                                                             |
| Buffer append                  | Primop candidate              | Gleam, JavaScript, Duck, Blot runtime lowering                                           |
| Persistent `Store`             | Primop candidate              | JavaScript and storage-oriented consumers                                                |
| Explicit runtime fault         | Distinct control effect       | Demand-sensitive faults and diagnostics                                                  |
| Lazy/strict evaluation mode    | Evaluation metadata           | Lazuli is lazy; other frontends are strict                                               |
| Module evaluation profile      | Public semantic contract      | Cannot be removed without an explicit-evaluation replacement                             |
| Effect sets                    | First-class metadata          | Higher-order inference and host boundary                                                 |
| Lexical effect evidence        | Surface lowering contract     | Duck and gpufuck handlers; do not move into primops                                      |
| Type schemas/annotations       | Checking metadata             | HM, indexed constructors, rank-N checking                                                |
| Join-point recognition         | Backend metadata              | Preserves Gleam tail calls without Core closures                                         |
| Case defaults/recursive groups | Surface sugar                 | Host elaboration before packing                                                          |
| Monomorphisation               | Frontend/backend optimization | Blot already specializes before gpufuck                                                  |
| Inlining/direct-call fusion    | Backend optimization          | Existing Wasm codegen already performs it                                                |
| `StrictLet`/`StrictApply` tags | Surface evaluation encoding   | Lower to ordinary Core nodes plus evaluation mode                                        |

No exported construct is confirmed unused. The public runtime module has 109 runtime exports; types
add further compile-time-only exports. `CoreTag`/`ExpressionTag` appear 1,056 times across 28
gpufuck source files, and primitive operator/conversion enums appear 402 times. Production
TypeScript is 63,689 lines in gpufuck, 127,914 in Duck, and 8,458 in Blot, excluding tests.

The semantic invariants that cannot be moved out of the total complexity count are:

1. lazy sharing, demand-sensitive faults, termination, and blackholes;
2. strict-eager frontend behavior;
3. HM/indexed-constructor/rank-N checking and malformed-input rejection;
4. effect-set propagation and lexical evidence;
5. persistent Store bounds/allocation behavior;
6. join-point and recursive tail-call preservation;
7. GPU, linear-memory Wasm, and WasmGC agreement;
8. bounded fuel, memory, cancellation, and diagnostics;
9. packed ABI ownership, spans, and deterministic validation.

## Shared baseline

`deno task bench` passed against `benchmarks/baseline.json` in the baseline and synthesis worktrees.
Exact counters stayed unchanged:

| Workload                  |   Nodes | Other exact counters                                                                  |
| ------------------------- | ------: | ------------------------------------------------------------------------------------- |
| Generated Gleam module    |   1,174 | 39 definitions; 17,939 inference transitions; 4,835 semantic steps; 40,005 Wasm bytes |
| Generated Gleam batch 64  |  75,136 | 371,208 source bytes                                                                  |
| Generated Gleam batch 256 | 300,544 | 1,498,968 source bytes                                                                |
| Linked project            |  60,031 | 51 modules                                                                            |

The twelve-program baseline contains 2,309 Surface nodes. Its frequent tags are 773 names, 762
applications (`Apply` plus `StrictApply`), 257 integers, 119 pattern binders, 98 lambdas, 91 case
arms, 61 binary operations, and 52 cases. The operator sample contains 19 integer additions, nine
integer equalities, seven integer multiplications, and smaller signed-i64, structural, and f64
families.

Existing repository measurements remain relevant controls:

| Existing result                   |                                        Measurement |
| --------------------------------- | -------------------------------------------------: |
| Each extra unary Lazuli parameter |          +5 nodes, about +90 inference transitions |
| Gleam stdlib before contification | 49,964 nodes; 1,265,365 transitions; 1,745 KB Wasm |
| Gleam stdlib after contification  |     17,718 nodes; 405,343 transitions; 999 KB Wasm |
| Sweep editor                      |        718 nodes; 15,537 transitions; 24.8 KB Wasm |

## Experiment 1: structural Core

The prototype recognizes lambda and application spines, removes executable `CaseArm` and
`PatternBind` nodes, and charges conservative trailing metadata words for parameters, arguments,
alternatives, and binders. It preserves the eight-word primary node record.

| Corpus                     | Current nodes | Projected nodes | Node reduction | Packed-word reduction |
| -------------------------- | ------------: | --------------: | -------------: | --------------------: |
| Lazuli brainfuck compiler  |         1,128 |             863 |         23.49% |                17.09% |
| Lazuli lazy                |            11 |              11 |             0% |                    0% |
| Lazuli syntax tour         |            98 |              76 |         22.45% |                16.20% |
| Gleam list fold            |            50 |              35 |         30.00% |                22.25% |
| Gleam guards               |            67 |              67 |             0% |                -2.61% |
| Gleam records              |            53 |              45 |         15.09% |                 9.67% |
| Sweep editor               |           718 |             489 |         31.89% |                22.25% |
| Sweep higher order         |            27 |              23 |         14.81% |                 9.26% |
| Sweep shapes               |            33 |              26 |         21.21% |                13.64% |
| JavaScript array pipeline  |            73 |              50 |         31.51% |                23.12% |
| JavaScript closure         |            12 |              11 |          8.33% |                 4.17% |
| JavaScript number pipeline |            39 |              35 |         10.26% |                 7.37% |
| **Total**                  |     **2,309** |       **1,731** |     **25.03%** |            **17.76%** |

Duck's functions example projects 15 to 13 nodes; its higher-order and loop examples are unchanged.
Blot's minimal program is unchanged and collections projects 372 to 294 nodes.

This is the only hypothesis that survives for an executable ABI prototype. Partial applications must
be eta-expanded at the Surface boundary; over-applications must split using the grouped function
type. Zero-arity functions must be genuine and must not reintroduce synthetic unit.

## Experiment 2: explicit evaluation

The model implements memoizing `Delay`/`Force`, marks a cell as evaluating before entering its
computation, and detects recursive force as a blackhole.

| Lazuli corpus      |   Current | Explicit nodes |     Growth |
| ------------------ | --------: | -------------: | ---------: |
| Brainfuck compiler |     1,128 |          1,961 |     73.85% |
| Lazy               |        11 |             16 |     45.45% |
| Syntax tour        |        98 |            168 |     71.43% |
| **Total**          | **1,237** |      **2,145** | **73.40%** |

Memoized sharing evaluates once, an unused delayed fault remains unobserved, and a cyclic thunk
reports `blackhole`. Representation growth alone rejects the design. Module profiles, node modes,
and strict Surface edges remain.

## Experiment 3: table-driven primops

The prototype table has 93 unique entries: six unary, 66 binary, 14 conversions, buffer append, and
six Store operations. Each entry owns arity, type scheme, fault class, effects, and host/WGSL/
linear-Wasm/WasmGC availability. Host lookup has 93 entries; WGSL lookup has 84 supported entries
and nine explicit unsupported entries.

It reduces ten primitive tags to one `Prim` tag, but the unchanged compiler has 301 primitive-
specific references in 24 files. Because it does not generate or delete those consumers, it fails
the plan's deletion rule. Keep the branch as the schema for a later generator experiment.

Bool/`if` constructor normalization was not implemented: current control-flow and tail-position
analysis make it higher risk, and there is no evidence for a 5% win.

## Experiment 4: checking-only typed Core

The local checker supports typed binders, type abstraction/application, nominal constructors, and
primitive calls. It checks representative Sweep arithmetic in four transitions, polymorphic Duck
identity in three, and polymorphic Blot empty-array construction in two. Repeating all three 100,000
times measured 131.9 ns/check in this run.

The complete-lowering audit rejects the design:

| Consumer | Missing retained facts                                            |
| -------- | ----------------------------------------------------------------- |
| Lazuli   | Typed local binders and explicit type applications                |
| Gleam    | Typed local binders, dictionaries, and constructor instantiations |
| Sweep    | Local binder elaboration                                          |
| Duck     | Types on every target expression and explicit instantiations      |
| Blot     | Binder types and explicit type applications in gpufuck lowering   |

The kernel is fast because the experiment supplies facts by hand. Producing those facts remains
inference work, so adopting it would move complexity into five adapters.

## Experiment 5: Wasm specialization and inlining

The measurement uses the proposed caps—four versions per function, 10% body growth, and inlining
only nonrecursive callees of at most eight nodes—as an audit of existing workloads. It does not add
versions because gpufuck already specializes direct call sites and inlines sole calls.

| Workload                 | Core nodes | Linear Wasm |  WasmGC | Existing specialized sites | Median linear run |
| ------------------------ | ---------: | ----------: | ------: | -------------------------: | ----------------: |
| One concrete identity    |          5 |     1,418 B |   790 B |                          1 |          0.030 ms |
| Many concrete identities |          9 |     1,428 B |   920 B |                          2 |          0.020 ms |
| Higher-order call        |         12 |        52 B | 1,019 B |                          0 |          0.007 ms |
| Recursion                |         21 |        98 B | 1,232 B |                          1 |          0.008 ms |
| Hot numeric loop         |         21 |        99 B | 1,234 B |                          1 |          0.028 ms |

These are raw single-worktree measurements, not an A/B. No new optimization reaches the required 5%
runtime improvement, so Core remains polymorphic and the existing backend optimizations remain.

## Synthesis

The synthesis branch combines and reruns the structural and primop tools. Interaction does not
change the structural result: 2,309 nodes still project to 1,731 and 18,472 packed words to 15,191.
The primop table still has 301 references that the prototype does not generate away.
`deno task
bench` retains every exact baseline counter.

Therefore synthesis accepts only the structural representation as the next executable experiment,
not as production code. Primops do not join the recommended migration until a generator deletes the
duplicated backend/type rules.

## Recommended Core and Surface boundary

The target for the ABI-7 executable prototype is direct style with metadata join points:

```text
value ::= literal
        | local depth
        | global definition
        | constructor constructor-index
        | lambda parameters body

term  ::= value
        | let value body
        | let-rec bindings body
        | call callee arguments
        | unary opcode operand
        | binary opcode left right
        | numeric-convert opcode operand
        | buffer/store operation operands
        | if condition consequent alternate
        | case scrutinee alternatives
        | fault message

alternative ::= constructor-index binders body
```

Parameters, arguments, recursive bindings, alternatives, and binders occupy trailing packed sections
addressed by the existing primary buffers. Join points remain analysis metadata: a proven
non-escaping saturated tail call compiles as a jump. Effects and lexical evidence remain unchanged.
Evaluation profiles and modes remain. Monomorphisation and inlining remain backend-only.

The public Surface should expose exact-arity `lambda(parameters, body)` and
`apply(callee, arguments)`, including empty lists. It should continue to expose source names, spans,
case defaults, recursive groups, effects, schemas, and evaluation policy. Frontends own eta
expansion for partial application and splitting for over-application.

## Conditional deletion list

An executable structural prototype must delete, rather than deprecate:

1. unary lambda/application spine construction and traversal;
2. synthetic unit parameters and arguments for zero-arity functions;
3. executable `CaseArm` and `PatternBind` nodes;
4. their inference, evaluator, capture, storage, trace, and Wasm switch arms;
5. ABI-6 node validators and serializers in the same breaking release.

Do not delete evaluation profiles/modes, effect sets/evidence, HM/indexed/rank-N inference, explicit
faults, dedicated `if`, Store semantics, or existing backend specialization.

## Production migration

1. Add exact baseline counters for Duck and Blot modules to their own repositories.
2. Implement trailing packed sections and exact-arity nodes behind ABI 7 in the structural branch.
3. Update lowering, validation, inference, GPU evaluation, linear Wasm, WasmGC, traces, capture,
   storage, and tail-call analysis together.
4. Update Lazuli, Gleam, Sweep, and JavaScript lowering; add partial/over/zero-arity behavior tests.
5. Update Duck in the same release. Its gpufuck-0.6 adapter also needs `purity` replaced by explicit
   effect sets, as demonstrated by `research/primitive-synthesis-duck`.
6. Update Blot's monomorphized lowering and rerun empty-array, handler, host-effect, and
   three-runtime agreement cases.
7. Delete ABI 6 completely. Do not carry a compatibility decoder.
8. Only then repeat the primop experiment with generated consumers. Include it in ABI 7 only if it
   deletes the 301 references' duplicated rules and passes the 5% guardrail.
9. Remeasure the combined executable compiler. Do not infer results from the representation model.

## Verification

Gpufuck synthesis passes:

```text
deno task fmt
deno task lint
deno task check
deno task test
deno task bench
```

Blot passes 133 tests and `just wasm`; the latter confirms interpreter, GPU evaluator, and emitted
Wasm agreement for polymorphic collections, handlers, shadowed effects, and host capabilities.
`just check` type-checks successfully and lint passes, but its baseline has two unrelated formatter
failures in `README.md` and `src/comptime/primitives.ts`.

Duck needed the six-line effect-contract migration before it type-checked against gpufuck 0.6.
Afterward lint, typecheck, architecture, the ordinary runtime examples, raytracer, and WAV case
studies pass. Its full gates do not pass on the clean `d302fa5` baseline:

- `fmt-check` reports eight already-unformatted tracked files;
- examples run successfully but two grammar-coverage assertions fail;
- editor fails on a Baba parser error in `piece_tree.duck`;
- the compiler suite reports 81 passes and 68 failures, including the existing 65,536-node cap.

Targeted controls reproduce representative failures against Duck's original
`jsr:@mewhhaha/gpufuck@0.4.0`, including the Codex app-server type mismatch and the typed-CLI
65,536-node overflow. They are consumer-baseline failures, not caused by these experiment tools.

## Theoretical basis

[System F with join points](https://simon.peytonjones.org/assets/pdfs/compiling-without-continuations.pdf)
supports direct style, saturated jumps, and join metadata without closure allocation.
[Call-by-push-value](https://link.springer.com/book/10.1007/978-94-007-0954-6) supplies the
value/computation distinction, while
[STG](https://www.cs.tufts.edu/comp/150FP/archive/simon-peyton-jones/spineless-jfp.pdf) explains why
memoized thunks and blackholes are semantic machinery. The explicit-evaluation experiment shows that
this theory does not imply a smaller gpufuck representation.

[GHC primops](https://downloads.haskell.org/ghc/7.6.3/docs/html/users_guide/primitives.html) support
separating runtime operations from the calculus, but a table is useful only when it generates and
deletes consumers. [Generalized evidence passing](https://xnning.github.io/papers/multip.pdf) is the
comparison for handlers; gpufuck's first-class effect sets and lexical evidence remain outside this
pass.
