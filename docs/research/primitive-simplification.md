# Primitive simplification and ABI 7 implementation

Date: 2026-07-29. Gpufuck baseline: `86e112b`, package 0.6.0, Functional ABI 6. Duck baseline:
`d302fa5`. Blot baseline: `aacf778`.

## Implementation outcome

The accepted structural design and the generated primop design were implemented together on
`research/primitive-abi7-production`, then promoted to `main` in `5015f28` as Functional ABI 7.
Package 0.7.0 was recorded in `45cc6d4`; there is no ABI-6 compatibility decoder.

- `Lambda(firstParameter, parameterCount, body)` and `Apply(callee, firstArgument, argumentCount)`
  use trailing parameter and argument tables. Empty lists are genuine zero-arity functions and
  calls.
- `Case(scrutinee, firstAlternative, alternativeCount)` uses packed alternative and binder tables.
  `CaseArm` and `PatternBind` are not emitted as Core expressions. Linear Wasm and WasmGC consume
  the packed tables directly.
- `Prim(opcode, firstOperand, operandCount, auxiliaryType)` replaces emitted unary, binary,
  conversion, buffer, and persistent-Store operation nodes. One declaration table owns opcode,
  arity, type rule, fault class, effects, and backend availability and generates the WGSL lookup.
- Lazuli remains a unary source language and emits one-element parameter and argument lists.
  Grouping its curried constructor spines caused 43,399 transitions for the 128-level repeated-tuple
  stress case versus 13,575 for 64 levels, breaching the proportional-work guardrail. Keeping those
  calls unary restores the existing bound while retaining the list ABI. Gleam, Sweep, JavaScript,
  and the public Functional Surface emit their natural exact arities.

The current integrated gpufuck suite passes 408 tests, including GPU evaluation, packed compilation,
linear-memory Wasm, WasmGC, rank-3 and indexed inference, lazy sharing and blackholes, genuine
zero-arity calls, polymorphic Store values, effects, and malformed-input rejection.

The final suite includes the nested-scrutinee metadata regression found by Blot. The benchmark
counters compare as follows:

| Workload                          |              ABI 6 |              ABI 7 |    Change |
| --------------------------------- | -----------------: | -----------------: | --------: |
| Four-arm or-pattern               |          213 nodes |          159 nodes |    -25.4% |
| Generated Gleam module            |        1,174 nodes |        1,036 nodes |    -11.8% |
| Generated Gleam inference         | 17,939 transitions | 17,328 transitions |     -3.4% |
| Generated Gleam semantic lowering |        4,835 steps |        2,214 steps |    -54.2% |
| 64-module batch                   |       75,136 nodes |       66,304 nodes |    -11.8% |
| 256-module batch                  |      300,544 nodes |      265,216 nodes |    -11.8% |
| Linked 51-module project          |       60,031 nodes |       52,993 nodes |    -11.7% |
| Generated Gleam Wasm              |       40,005 bytes |       40,005 bytes | unchanged |

The Wasm packed-case follow-up on 2026-07-31 removed the backend-only expansion that remained after
ABI 7. On the reachable Gleam stdlib corpus, backend lowering now produces 15,750 nodes instead of
17,719 by omitting 812 case-arm and 1,157 pattern-binding nodes. Four alternating process pairs
measured 24 emissions per process after three warmups:

| Measurement              | `0be17e2` control | Packed-case backend | Change |
| ------------------------ | ----------------: | ------------------: | -----: |
| Full Wasm compile median |          37.79 ms |            35.42 ms |  -6.3% |
| Backend-plan median      |           9.33 ms |             7.82 ms | -16.2% |
| Emitted artifact         |     297,776 bytes |       297,776 bytes |   none |

Both variants produced SHA-256 `afb920a44162da9459b770a876c2089626b0ebb196039a7bc00ed4b34223e94a`,
so runtime code is byte-identical. The complete 408-test suite passed after the change.

The next follow-up removed a second whole-program lambda-flow solve for effectful modules. Semantic
effect inference already needs finite lambda provenance; it now computes that provenance over the
same lowered Core consumed by Wasm and privately retains both immutable results on the completed
module. Linear Wasm reuses them. Pure, transferred, source-rebound, and literal-updated modules
retain the ordinary lowering and analysis fallback, so preparation is an optimization rather than a
new module invariant or public API.

The machine was concurrently occupied by an unrelated high-priority job, so separate-process wall
times drifted too much to compare. The accepted measurement instead loaded both revisions in one
process, pinned that process to one CPU, alternated revision order on every repetition, discarded
four warmups, and measured twelve adjacent pairs:

| Reachable Gleam stdlib work | `7e09e27` control | Shared analysis | Change |
| --------------------------- | ----------------: | --------------: | -----: |
| Semantic wall time          |          83.47 ms |        87.70 ms |  +5.1% |
| Wasm wall time              |         114.69 ms |        95.52 ms | -16.7% |
| Complete wall time          |         192.45 ms |       180.50 ms |  -6.2% |
| Complete process CPU time   |         191.54 ms |       178.97 ms |  -6.6% |

The semantic-only cost is explicit: preparing Wasm Core adds work when an effectful module is never
sent to Wasm. The complete path clears the 5% acceptance threshold, while pure modules do not take
the preparation path. Both revisions emitted the same 297,776-byte artifact with SHA-256
`afb920a44162da9459b770a876c2089626b0ebb196039a7bc00ed4b34223e94a`. The complete suite now passes
409 tests, including higher-order and fully applied curried effect inference.

Two follow-up representation changes were rejected. Preparing the complete Wasm Core index beside
lambda flow replaced the latter's lightweight parent index but moved too much backend-only work into
semantic compilation. In twelve alternating same-process pairs, semantic compilation rose from 84.04
to 94.44 ms, Wasm fell from 85.24 to 70.22 ms, and the complete path regressed from 167.54 to 170.91
ms, or 2.0%. Encoding function bodies into typed byte arrays was also rejected. Its only changed
trace stage, `wasm.encode`, moved from 10.24 to 11.12 ms; larger apparent whole-process changes were
unrelated JIT and garbage-collection drift. Both spikes remain isolated on
`perf/reuse-wasm-core-index` and `perf/typed-wasm-function-bodies`.

A V8 CPU profile establishes the next architectural boundary. The representative artifact contains
1,528 required functions, 266,055 instruction bytes, and 13,550 locals. Across 1,492 samples, no
gpufuck JavaScript routine accounted for 2% of total CPU: work is distributed across lambda flow,
Core indexing, capture analysis, recursive instruction emission, collection operations, and binary
encoding. Another local data-structure substitution therefore cannot credibly meet the 5% threshold.

The next Wasm experiment should separate deterministic closure conversion from body emission. A
single immutable plan must assign every function slot, capture layout, call target, and function
type before code generation. Each planned body can then be emitted independently, dispatched to a
bounded worker pool for large modules, and concatenated in slot order; small modules should stay on
the serial path. Parallelizing the current emitter is not credible because body compilation still
discovers and mutates shared slots recursively. This is a new backend phase boundary, not a batching
flag, and requires its own runtime, compile-time, and worker-transfer break-even measurements.

The original same-machine timing runs were noisy: ABI 7 was faster for the 64- and 256-module
batches, while the single module and linked project were slower by more than 5% in the sampled
medians. The benchmark task deliberately treats timings as advisory. Production promotion was a
subsequent explicit decision, not evidence that those samples met the research guardrail.

Blot passes 143 tests and its complete `just wasm` corpus; the interpreter, GPU evaluator, and
emitted Wasm agree, including polymorphic collections and effects. Its existing formatter gate
reports five unrelated unformatted files. Duck's isolated synthesis worktree has the ABI-7 lambda
adapter and passes its first 35 compiler tests; the larger Codex-derived cases retain the synthesis
baseline's existing failures, so Duck is not represented as fully green.

## Research checkpoint decision

The checkpoint decision below predates the executable implementation and is retained as the evidence
that led to ABI 7.

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
| Demand/sequence mode           | Evaluation metadata           | Ordinary bindings are lazy; explicit sequence nodes preserve required order              |
| Effect sets                    | First-class metadata          | Higher-order inference and host boundary                                                 |
| Lexical effect evidence        | Surface lowering contract     | Duck and gpufuck handlers; do not move into primops                                      |
| Type schemas/annotations       | Checking metadata             | HM, indexed constructors, rank-N checking                                                |
| Join-point recognition         | Backend metadata              | Preserves Gleam tail calls without Core closures                                         |
| Case defaults/recursive groups | Surface sugar                 | Host elaboration before packing                                                          |
| Monomorphisation               | Frontend/backend optimization | Blot and gpufuck keep Core definitions polymorphic                                       |
| Inlining/direct-call fusion    | Backend optimization          | Existing Wasm codegen already performs it                                                |
| `Sequence` tag                 | Surface ordering encoding     | Lowers to a Core let whose value must run before its body                                |

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
applications across the then-separate eager and demand forms, 257 integers, 119 pattern binders, 98
lambdas, 91 case arms, 61 binary operations, and 52 cases. The operator sample contains 19 integer
additions, nine integer equalities, seven integer multiplications, and smaller signed-i64,
structural, and f64 families.

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

Do not delete demand/sequence modes, effect sets/evidence, HM/indexed/rank-N inference, explicit
faults, dedicated `if`, Store semantics, or existing backend specialization.

## Production migration

1. Add exact baseline counters for Duck and Blot modules to their own repositories.
2. Implement trailing packed sections and exact-arity nodes behind ABI 7 in the structural branch.
3. Update lowering, validation, inference, GPU evaluation, linear Wasm, WasmGC, traces, capture,
   storage, and tail-call analysis together.
4. Update Lazuli, Gleam, Sweep, and JavaScript lowering; add partial/over/zero-arity behavior tests.
5. Update Duck in the same release. Its gpufuck-0.6 adapter also needs `purity` replaced by explicit
   effect sets, as demonstrated by `research/primitive-synthesis-duck`.
6. Update Blot's polymorphic lowering and rerun empty-array, handler, host-effect, and three-runtime
   agreement cases.
7. Delete ABI 6 completely. Do not carry a compatibility decoder.
8. Only then repeat the primop experiment with generated consumers. Include it in ABI 7 only if it
   deletes the 301 references' duplicated rules and passes the 5% guardrail.
9. Remeasure the combined executable compiler. Do not infer results from the representation model.

## Blot structural-mismatch follow-up

The 2026-07-31 audit corrected the original adapter attribution before changing Core. Blot has 17
`nominal(` call sites, 25 `unsupported()` call sites, and five `runtimeFault` call sites. These are
call-site counts; line-matching counts are not a substitute. The previously reported 26% was only
`backend/` as a share of repository lines. It did not measure time or code caused by gpufuck, and
1,031 of those 4,382 backend lines stage the ABI, imports, and exports required by any target.

Blot also does not duplicate definitions for record shapes. The change at `47fa577` records
instantiation correspondence beside its type lattice and walks those facts only when collecting
backend shapes. The corpus emits byte-identical Wasm. That machinery makes one concrete nominal
recoverable; it does not make invariant Core records structurally polymorphic, and it still refuses
two distinct layouts reaching one generalized projection.

Three scoped additions were accepted without a new Core tag or ABI change:

- `HasField<label, record, value>` is typed Surface evidence. A frontend constructs an accessor
  where the complete nominal layout is known, while the shared projection consumes only the field
  label, record, and evidence. Field labels and evidence constructors elaborate to existing typed
  constructors, lambdas, and cases before Core inference. One annotated `getX` definition now
  projects from both `FirstRecord{x, enabled}` and `SecondRecord{name, x}` without definition
  cloning; GPU inference, linear Wasm, and WasmGC agree on 42. This is the constrained subset needed
  for a staged Blot migration, not unrestricted row polymorphism or a dynamic record dictionary.
- `join(name, parameter, body, continuation)` and `jump(name, value)` expose value-carrying forward
  joins as ordinary Surface `let` and application. Linear Wasm contifies a one-argument binder only
  when every reference is a saturated tail call, carries live arguments through a typed block, and
  still evaluates strict dead arguments. Blot now lowers source-unspellable return/break outcome
  cases to these joins while leaving user variants unchanged.
- Linear Wasm and WasmGC run a conservative dominating-fact analysis before emission. A Store read
  loses its runtime check only when the same index is proven below the same Store's length and is
  nonnegative, or when an exact length proves a nonnegative constant index. No trusted frontend
  assertion was added. The performance trace reports `provenStoreReads`, including one discharged
  check in the regression workload. More elaborate loop induction remains future analysis rather
  than an unchecked evidence escape hatch.

The bounds pass has an explicit no-Store fast path. In 60 alternating same-process pairs on the
1,036-node generated Gleam module, median complete Wasm emission was 1.676 ms before and 1.663 ms
after; planning was 0.520 ms in both cases. This is within measurement noise and avoids charging
ordinary consumers for a Store-specific proof. A 13-node one-read microcase moved from 0.119 to
0.128 ms to compile and from 1,402 to 1,382 bytes. The 0.010 ms fixed proof cost is proportionally
8.4% only because the entire control compiles in about a tenth of a millisecond.

A repeated-call control makes the trade measurable at run time. For 100,000 reads below the same
dominating length fact, 60 alternating calls measured 0.330 ms before and 0.281 ms after, a 14.9%
reduction; the artifact fell from 1,509 to 1,488 bytes. Dividing the one-time 0.010 ms compile cost
by the 0.049 ms saved per 100,000 reads gives a break-even near 20,200 executed reads. Cold or
rarely executed reads retain a tiny absolute compile cost; hot Store loops clear the runtime
guardrail.

Against a detached `47fa577` Blot control using the same gpufuck checkout, the control-flow lowering
changed these static totals:

| Blot example            | Control nodes | Join nodes | Change | Control types | Join types | Control constructors | Join constructors |
| ----------------------- | ------------: | ---------: | -----: | ------------: | ---------: | -------------------: | ----------------: |
| `returning.blot`        |         1,004 |        825 | -17.8% |            31 |         17 |                   48 |                20 |
| `breaking.blot`         |         1,100 |        936 | -14.9% |            32 |         18 |                   41 |                21 |
| `conditional_rebinding` |           881 |        881 |     0% |            20 |         20 |                   23 |                23 |

The unchanged conditional case contains no synthetic control family, which is the expected negative
control. The optimization removes the one-field control payload wrapper as well as the synthetic
outcome sums. A nested live-join path in `tour.blot` exposed a WebAssembly validation edge:
structured validation does not prove that all arms branch away. Emission now terminates the
syntactic block fallthrough with `unreachable`; the tour and the complete corpus again agree across
the interpreter, GPU evaluator, and Wasm.

The priority distinction is now explicit. Dominating bounds facts are the lowest-risk runtime win.
`HasField` is the larger adapter-deletion opportunity, but Blot must elaborate and pass evidence at
polymorphic call sites before deleting its shape-fact machinery. Value joins remove hand-encoded
control data immediately. Blot's still-variable spread, in-place parameter destructuring, and
cross-import projection cases remain Blot frontend work rather than gpufuck Core gaps.

## Post-production discarded-work checkpoint

The 2026-07-30 follow-up traced Storage Core decisions from derivation through Wasm emission. A
Gleam stdlib compilation derived 3,083 value decisions and 3,298 references. Emission consulted
1,895 decisions—733 closures and 1,162 constructors—and discarded the result after asserting that
the already-selected representation agreed. The remaining 1,188 decisions, or 38.5%, were not
consulted at all. No consulted decision selected an emitted representation.

Ordinary Wasm compilation therefore no longer derives, verifies, or retains a Storage Core plan. The
existing Core index owns the shared weak-head-normal-form classification, and code generation
derives arena reset eligibility from the global thunks it actually emits. A caller-supplied Storage
Core still takes the complete derivation and verification path because it is an external contract.
The trace keeps `wasm.plan.storage`, annotated as skipped, so the absence of work remains
observable.

Three fresh processes measured the same pinned Gleam stdlib checkout before and after removing the
discarded plan:

| Measurement                     | Raw baseline (ms)      | Raw simplified (ms)    | Process median change |
| ------------------------------- | ---------------------- | ---------------------- | --------------------: |
| Direct Wasm emission            | 74.8, 79.2, 80.0       | 72.4, 61.6, 67.2       |                -15.2% |
| Complete cold CPU compilation   | 220.8, 238.9, 234.1    | 234.0, 203.8, 219.2    |                 -6.4% |
| Traced Wasm compilation         | 90.324, 90.947, 89.345 | 76.482, 76.410, 83.762 |                -15.3% |
| `wasm.plan.storage` trace stage | 14.9–17.9              | approximately 0.001    |               -100.0% |

The representative Wasm artifact remained 1,939 bytes with identical SHA-256
`a336a6591bb4d6381a3f5203d440ed5ba17493bf8c50e77e8d8a584894bfe372`. This change passes both
performance guardrails and the semantic-output check.

The Baba source-position boundary also stopped allocating and filling a UTF-16-to-UTF-8 table for
ASCII source. Seventeen of the nineteen stdlib modules are ASCII. Repeated construction and span
lookup over that corpus measured 40.5 ms versus 64.5 ms for the previous implementation, a 37.1%
reduction. Non-ASCII input retains the complete offset table and has explicit multibyte and
surrogate-pair coverage.

A direct Baba cursor-to-Surface lowering was rejected at this checkpoint. Baba 7.6 exposes cursor
operations but keeps its flat rule, child, field, and value tapes private, while gpufuck's complete
Gleam semantics live in the 1,280-line AST parser and 2,815-line AST-to-Surface lowering. Recreating
those rules over cursor calls would duplicate the frontend instead of deleting work. The earlier
function-body deferral spike merely postponed AST materialization and regressed parse plus lowering
from 125.2 ms to 140.2 ms, or 12.0%. A credible direct path requires Baba to execute a Gleam
lowering recipe or expose a stable tape API; gpufuck should not add a second semantic frontend in
the meantime.

The subsequent Baba 7.9 update regenerated all three checked-in parsers with runtime ABI 12. Parser
plan sizes stayed unchanged; the shared runtime Wasm grew from 16,216 to 17,487 bytes and added
incremental lexing, validation, and parsing. It does not improve gpufuck's current full-parse path.
On the same generated 72,669-character Gleam module, three process medians were 11.10 ms with Baba
7.6 and 12.30 ms with Baba 7.9, a 10.8% regression. The stdlib benchmark's repeated parse medians
were 110.4 ms and 106.9 ms respectively, within the 5% noise guardrail, while its single traced
frontend parse moved from 84.77 ms to 91.76 ms.

`GleamFrontendService` now retains one Baba incremental document per active module. It sends a
single UTF-16 replacement edit computed from the shared prefix and suffix, retains the document
through syntax errors so the next correction remains incremental, and disposes documents when
modules leave the project or `clear()` is called. Its trace records changed ranges, scanned code
units, token creation and reuse, parser actions, reuse checks, and checkpoint creation and reuse.
Trailing-trivia-only edits retain the existing faster path that skips parsing entirely.

Three fresh processes edited the generated 20,526-character stdlib entry. Full parse plus Gleam AST
materialization measured 7.92 ms; incremental update, parse, and materialization measured 5.95 ms, a
24.9% reduction. Baba scanned five UTF-16 code units, created two tokens, reused 3,734 tokens and
3,732 checkpoints, and performed 150 parser actions. The cursor parse after `applyEdits` was
effectively free; the representative frontend costs were 4.57 ms for applying the incremental edit,
2.08 ms for AST materialization, 6.53 ms for lowering, and 14.44 ms for linking.

The benchmark now distinguishes an appended-comment edit from a real internal code edit. Complete
internal edit compilation and Wasm emission measured 161.0 ms versus Gleam's 12.2 ms. Incremental
parsing therefore removes about two milliseconds from this case but cannot meet the whole-compiler
5% guardrail while semantic compilation and Wasm emission still redo the linked program. Retain the
service optimization and its work counters, but do not credit it as an end-to-end compilation win;
the next edit-path work must make semantic and Wasm caches module-granular.

### Performance measurement audit

The next checkpoint found that edit tracing did not describe the code path being benchmarked.
`FunctionalCompilerService` discarded the trace option, while a traced `compileModuleToWasm` call
bypassed both its module artifact cache and its resolved-Core cache. The internal-edit trace
therefore stopped after frontend linking, and forwarding it without changing Wasm behavior would
have measured an uncached path that production did not run.

Tracing now follows the production cache path and records the cache level separately. Semantic
compilation reports exact-module hits, semantic-fingerprint hits with source rebinding, and misses.
Wasm reports exact-module and resolved-Core artifact hits, and `wasm.total` covers cache lookup,
Core readback, planning, and emission. The benchmark wraps every internal edit in `compiler.total`
and rejects a phase breakdown that double-counts more than one percent of that wall time.

On the 20-module, 261.5 KiB stdlib corpus, a representative internal edit reconciled 148.842 ms as
29.202 ms frontend, 45.528 ms semantic work, 72.781 ms Wasm work, and 1.332 ms unattributed
orchestration. The trace therefore attributes 99.1% of the measured wall time. It also exposed two
previously invisible whole-program hashes: the Surface semantic fingerprint took 11.150 ms and the
resolved-Core Wasm fingerprint took 8.751 ms. Together they consume 13.4% of internal-edit latency
when the edit changes program semantics.

A source-only edit takes a different path. The frontend registers semantic equivalence before the
compiler service runs, so both fingerprints and resolved-Core Wasm lookup are effectively free. Its
traced median was 13.390 ms: frontend relinking took 11.293 ms, source rebinding took 0.850 ms, and
the cached Wasm request took 0.070 ms. That trace attributes 93.3% of its total, making relinking
the next source-only target rather than hashing.

Cold comparisons now time the complete untraced gpufuck path directly instead of adding independent
frontend, semantic, and Wasm medians. Across three benchmark processes, the median complete path was
217.4 ms untraced and the median traced total was 234.4 ms. The traced number is for attribution,
not headline speed comparisons: its 7.8% difference includes instrumentation and cross-sample
machine noise. “Cold” also means different process boundaries for the two tools. Gpufuck runs
uncached compiler work inside an already-warm Deno process; each Gleam sample launches a new
compiler process after `gleam clean`, while operating system file pages may remain cached. The
benchmark reports those scopes explicitly.

### Blot compilation checkpoint

The 2026-07-31 Blot playground work measures the pipeline that users actually see: parser and syntax
resources, source loading, checking, staging, Surface encoding, GPU setup and Core compilation, then
concurrent GPU evaluation, ordinary Wasm execution, and canonical-ABI Wasm emission. Phase rows may
overlap and must not be summed. For a serial cold run the wall-time model is

```text
T_cold = T_syntax + T_blot + T_core-setup + T_core
       + max(T_gpu-run, T_wasm-run, T_canonical-wasm) + epsilon

T_core-setup = T_device + max(T_compiler-pipelines, T_evaluator-pipelines)
```

For an unchanged resident run, exact syntax, loaded/check/prepared modules, and resolved Core are
cached:

```text
T_resident = T_source-config + T_core-restore
           + max(T_gpu-run, T_wasm-run, T_canonical-cache) + epsilon
```

The benchmark now reports the Surface shape beside machine work. The representative cold samples on
the local Vulkan adapter were:

| Workload                 | Surface nodes | Definitions | Inference transitions | Transitions/node |
| ------------------------ | ------------: | ----------: | --------------------: | ---------------: |
| Compiled example         |             3 |           3 |                   170 |             56.7 |
| Language tour            |         1,376 |          42 |                65,212 |             47.4 |
| Storage metaprogramming  |           607 |          20 |                35,752 |             58.9 |
| 25-module stress project |         8,152 |          74 |               161,859 |             19.9 |

The stress project is large rather than pathologically expensive per node. Its 576 source functions
lower into nested functions inside 74 top-level Core definitions; 161,859 inference transitions are
only 19.9 per Surface node, the lowest density in the corpus. The cold Core cost remains important
because all 8,152 nodes are new work, but a special stress-only inference rule is not justified by
these counters.

Two resident caches were accepted. An exact `(source, parser plan)` syntax cache removes a repeated
GPU submission without weakening edit validation. A bounded canonical-Wasm cache is keyed by both
the resolved-Core structural fingerprint and the canonical interface fingerprint, so an artifact
cannot cross an ABI boundary. The progression was:

| Resident unchanged workload |  Before | Syntax cache | Canonical cache | Total change |
| --------------------------- | ------: | -----------: | --------------: | -----------: |
| Compiled example            | 39.0 ms |      23.7 ms |         23.5 ms |       -39.7% |
| Language tour               | 24.6 ms |       9.5 ms |          4.3 ms |       -82.5% |
| Storage metaprogramming     | 21.0 ms |       4.4 ms |          2.2 ms |       -89.5% |
| Stress project              | 46.8 ms |      30.2 ms |          9.6 ms |       -79.5% |

The three-node example is now bounded by a roughly 23 ms GPU evaluation/readback round trip, not by
compilation. The other resident cases also show why work and span must be distinguished: canonical
emission used CPU time while running beside GPU evaluation and ordinary Wasm. Removing it reduced
contention and shortened the critical path, but eliminating an off-critical concurrent task would
not necessarily reduce wall time.

The cache break-even condition makes the small lookup costs explicit. If a hit avoids work `E`, a
lookup costs `C`, and the hit probability is `h`, caching wins before memory costs when

```text
h E > C, therefore h > C / E.
```

The exact syntax lookup measured about 0.1 ms against about 15.7 ms of warm GPU ingest, a break-even
hit rate near 0.6%. The stress canonical lookup measured about 0.5 ms against about 20 ms of
repeated emission, a break-even near 2.5%. Both are far below the page's expected repeat-run hit
rate. Failed pending computations are evicted, and both caches retain their original malformed-input
behavior.

The GPU syntax path was then compared with Blot's required CPU cursor parse. Baba produces a useful
flat syntax IR, but Blot cannot consume that IR as its checked AST; it can reuse only lexer records.
GPU validation is therefore additive work. With both runtimes already initialized, five-sample
medians from `deno task bench:blot-syntax` were:

| Generated definitions | Source bytes | Blot CPU parse | Baba GPU + Blot parse |  Ratio |
| --------------------: | -----------: | -------------: | --------------------: | -----: |
|                    16 |          553 |        0.34 ms |              15.01 ms | 43.89x |
|                   256 |        8,233 |        4.56 ms |              22.07 ms |  4.84x |
|                 1,024 |       32,809 |       13.79 ms |              29.63 ms |  2.15x |
|                 4,096 |      131,113 |       54.71 ms |              76.03 ms |  1.39x |
|                 8,192 |      262,185 |       95.91 ms |             117.29 ms |  1.22x |

There was no GPU break-even before the current Blot parser action limit. Three alternating project
benchmark pairs confirmed the end-to-end result. CPU syntax changed median cold totals from 538.8 to
350.7 ms for the compiled example, 501.5 to 322.9 ms for the tour, 491.9 to 271.2 ms for storage,
and 725.1 to 531.3 ms for stress: reductions of 26.7–44.9%. The compiled literal-edit path changed
from 44.2 to 28.1 ms. The playground therefore uses Blot CPU syntax by default and retains Baba GPU
validation as an explicit demonstration switch. This is a boundary simplification, not a claim that
GPU parsing is intrinsically slow: the duplicated consumer IR is the problem.

Starting Baba and Core GPU setup concurrently was rejected. In three alternating process pairs,
serial-to-parallel medians were 590.4 to 576.7 ms for compiled, 504.3 to 538.2 ms for tour, 515.4 to
544.3 ms for storage, and 750.6 to 771.2 ms for stress. Two independent device acquisitions and
pipeline compilations contend; three workloads regressed by 2.7–6.7%. The benchmark keeps
`--parallel-setup` as a falsifiable experiment, while production stays serial.

Brent's work/span bound explains the concurrency result. For work `W`, span `S`, and `p` processors,

```text
max(W / p, S) <= T_p <= S + (W - S) / p.
```

Parallel launch helps only when independent work exceeds the contention and fixed scheduling cost.
The Core inference machine already completes each representative workload in one or two host
dispatches; one dispatch does not imply constant span because dependent unification transitions
still execute inside the persistent kernel. Frame histograms and transitions per node are therefore
more useful than dispatch count alone.

The next credible cold optimization is one shared `GPUDevice`. Baba 7.10's `WebGpuRuntime.create`
currently acquires and owns its device and exposes no external-device constructor. WebGPU objects
are device-specific, so gpufuck cannot safely splice its pipelines into Baba from the outside. An
upstream API needs explicit borrowed-device ownership and disposal rules; after that exists, repeat
the serial/parallel experiment before claiming the roughly 70 ms device-acquisition row as savings.

The design follows demand-driven incremental computation rather than blanket memoization:

- [Adapton](https://www.cs.umd.edu/~mwh/papers/adapton-submit.pdf) motivates demanded dependency
  graphs and from-scratch consistency; its warning that cache overhead can lose when all output is
  demanded is why every new cache has a measured break-even.
- [Hybrid incremental compilers](https://programming-journal.org/2020/4/16) support explicit stage
  dependencies and invalidation, and evaluate real edit histories rather than only unchanged runs.
- [Pacak, Erdweg, and Szabó](https://doi.org/10.1145/3428195) show how typing relations can be made
  finite and incrementally maintained. Gpufuck's current literal and semantic fingerprints are a
  narrower implementation; module-granular inference remains future work.
- [Brent's scheduling bound](https://maths-people.anu.edu.au/~brent/pub/pub022.html) supplies the
  work/span model above.
- The [WebGPU specification](https://www.w3.org/TR/webgpu/#dom-gpudevice-createcomputepipelineasync)
  defines asynchronous pipeline creation and device ownership constraints. Baba's own
  [experimental WebGPU module](https://jsr.io/@mewhhaha/baba/7.10.0/src/runtime/webgpu/mod.ts)
  likewise warns that mapped readback and setup favor CPU processing for small, one-off sources.

The next work should be module-granular Core compilation and artifact linking for semantic edits,
not another local data-structure substitution. It must first record affected definitions and
dependency SCCs, then compare `W_affected` with whole-module transitions while preserving
from-scratch consistency. Retaining live `GpuModule` buffers could save the 0.4–3.4 ms Core restore
row, but it needs bounded ownership or leases; an unbounded session cache is not accepted for that
small gain.

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
