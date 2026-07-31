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
