# Lazuli frontend

Lazuli is the reference frontend — the syntax the GPU semantic compiler was built against, and the
only one of the three that is lazy. Its adapter selects `EvaluationProfile.LazyCallByNeed` and
`TypecheckingProfile.HindleyMilnerIndexed`, so a Lazuli program exercises call-by-need thunks and
indexed constructors, which the strict Gleam and JavaScript frontends never reach. Its entry point
is `mod.ts` and its CLI is `lazuli_cli.ts`; neither ships in the published package. This directory
holds the sample programs both are run, tested, and profiled against.

Run one:

```sh
deno task run:lazuli examples/lazuli/option-map.laz
```

`run:lazuli` compiles on the GPU and evaluates on the GPU, printing the value plus the evaluator's
step, allocation, peak-stack, and thunk counts. `compile:lazuli` stops at resolved Core and dumps
the module — ABI version, node, definition, type and constructor counts, the constructor table with
arities, and every Core node. `run:lazuli-batch` takes several sources, compiles them as one batch
and evaluates them as one batch, and reports results in source-path order.

The experimental Baba pipeline keeps lexing, delimiter matching, parsing, and compact CST allocation
on the GPU before entering Lazuli's existing semantic lowering. It is intentionally not exported
from `mod.ts` or the published package. Benchmark it against the generated Wasm frontend with:

```sh
deno task bench:lazuli-baba
```

The benchmark reuses one WebGPU runtime and measures full ingest, lowering, and semantic compilation
for 64, 512, and 2,048 declarations. Baba rejects software fallback adapters by default, so these
numbers require a hardware WebGPU adapter. Baba 7.3 also reserves one compact node per source unit;
the all-rule Lazuli profile can therefore report `GPU_FRONTEND_NODE_CAPACITY` for tiny, syntax-dense
inputs even though the broad declaration workloads fit.

| Sample                   | What it demonstrates                                           |
| ------------------------ | -------------------------------------------------------------- |
| `answer.laz`             | The smallest whole program: `fn main = 6 * 7;`                 |
| `factorial.laz`          | Top-level recursion and `if`/`then`/`else`                     |
| `local-rec.laz`          | `let rec` inside a body, closing over an outer binding         |
| `closure.laz`            | `fun x -> ...` lambdas, capture, and partial application       |
| `constructor.laz`        | A partially applied constructor passed and used as a function  |
| `list.laz`               | The built-in `Cons`/`Nil` list, folded by a recursive `let`    |
| `collections.laz`        | List literal sugar lowering to those same constructors         |
| `option-map.laz`         | A user-declared generic `data` type and a higher-order `map`   |
| `proofs.laz`             | Indexed constructors, an uninhabited type, and an empty `case` |
| `syntax-tour.laz`        | Most of the surface in one file, for editor-theme inspection   |
| `brainfuck_compiler.laz` | A Brainfuck-to-WebAssembly compiler, `Text -> Text`            |

`lazy.laz` is the one to read for the evaluation profile: it binds `1 / 0` and never forces it, so
the program returns 42 instead of faulting, and it adds a single binding to itself to show
call-by-need sharing rather than re-evaluation.

`proofs.laz` is what `TypecheckingProfile.HindleyMilnerIndexed` buys. Constructors carry a result
type — `Refl : Equal a a` — so matching on one refines the indices in scope, which is how `cast` and
`transitive` typecheck. `data False = ;` declares an uninhabited type, and `case impossible of end`
is the empty match that eliminates it.

`brainfuck_compiler.laz` is a fixture as much as a sample. `tools/profile_semantic_compiler.ts`
takes it as its default source and `tests/semantic_gpu_workspace_test.ts` reads it directly, so
changing it moves profiling numbers and a workspace-growth assertion. Its `main` takes the Brainfuck
source as an argument, and the CLI supplies no inputs, so `run:lazuli` on it reports a closure —
that it compiles and reduces to one is the point, not the printed value.

`playground/build.ts` inlines every `.laz` file in this directory into the browser page so it needs
no fetch to become interactive. Adding a sample here adds a playground entry; nothing else needs
editing.
