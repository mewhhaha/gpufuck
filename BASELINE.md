# Baseline

Reproduce with `deno task bench:throughput`. Every performance claim in this repo is judged against
this file.

Marginal cost per module is the number that matters. Totals hide the crossover, because both the CPU
and GPU paths pay the same host parse — a total-wall-time ratio flatters the GPU.

## 2026-07-24 — before the node-parallel retarget

Ryzen 7 7800X3D, RTX 4080 SUPER, Deno 2.9.2, `maxStorageBuffersPerShaderStage` 16. Corpus:
two-definition Lazuli modules, one `helper` plus `main`.

| modules | CPU parse+infer (ms) | CPU infer (ms) | host lookup (ms) | GPU batch (ms) | GPU slower |
| ------- | -------------------- | -------------- | ---------------- | -------------- | ---------- |
| 1       | 0.30                 | 0.05           | 0.02             | 12.53          | 41.1x      |
| 16      | 1.65                 | 0.27           | 0.09             | 14.50          | 8.8x       |
| 64      | 3.12                 | 1.11           | 0.12             | 19.55          | 6.3x       |
| 256     | 11.69                | 3.73           | 0.46             | 40.85          | 3.5x       |
| 1024    | 41.87                | 11.60          | 3.24             | 120.23         | 2.9x       |

Marginal cost per module at N=1024:

| work                  | µs/module | note                                        |
| --------------------- | --------- | ------------------------------------------- |
| CPU parse + inference | 39.3      | the honest end-to-end baseline              |
| CPU inference alone   | 10.2      | exactly what the GPU replaces               |
| host symbol lookup    | 3.6       | the GPU path pays this too, before dispatch |
| GPU batch total       | 103.4     |                                             |
| GPU inference share   | 99.7      | **9.7x the CPU work it replaces**           |

## Noise

GPU batch timings spread roughly 30% run to run on this machine: the same tree measured 96.6, 101.2,
108.3, 117.1, and 129.7 µs/module across separate runs. **A single run cannot distinguish a real
change from noise.** Compare medians across at least three runs, and treat anything under about 20%
as unmeasured. The flat-grid lowering change looked like a 14% win on one run and was flat under a
proper A/B.

## What these numbers mean

**The GPU loses at every batch size, and the gap converges rather than crossing.** Its marginal cost
per module exceeds the CPU's total cost per module, so no batch size wins. The CPU baseline is
`inferTypes` in `src/semantic/type_inference.ts` — the host Hindley-Milner implementation that the
GPU shader is differentially tested against in `tests/semantic_gpu_diagnostic_parity_test.ts`, so
both columns do the same work.

**Two independent causes, with different fixes.**

1. _Floor (~11.4 ms)._ Deno's `mapAsync` stalls ~11.4 ms per await even on a buffer with nothing
   submitted; eight concurrent awaits cost the same as one. This is the whole of the N=1 number and
   it is a runtime property, not a compiler one. Unmeasured in Chrome.
2. _Slope (~9.7x)._ The semantic, inference, and evaluator kernels are all
   `@compute @workgroup_size(1)`, one lane per module, running a serial `loop { if phase == … }`
   state machine over a 74-field `var<private>` struct. The one exception, `lower_planned_module` at
   `workgroup_size(64)`, only copies a lowering plan the host already computed — about 2,300 of the
   ~28,800 GPU transitions per module. This survives any runtime fix.

**The Amdahl ceiling is 1.35x.** Parsing is 74% of the CPU path and stays on the CPU (baba). Even a
free, instantaneous GPU inference would only take the CPU path from 39.3 to 29.1 µs/module. Every
kernel-level improvement is bounded by this until parsing moves or gets faster.

For reference, baba parses at ~0.43 µs/byte (≈2.3 MB/s) with a ~17 µs fixed cost per call, where
tree-sitter does 10–30 MB/s. A 10x parser improvement would outweigh the entire retarget.

## 2026-07-25 — against the Gleam compiler, on one large real module

The throughput numbers above use a synthetic corpus of two-definition modules, which measures
_batching_. This measures the opposite case, and the one a language implementer actually has: a
single large program, compiled once, against the production compiler for that language.

Corpus: `gleam-lang/stdlib` at `bacc20c`, nineteen source modules, 252 KB, all reachable — the entry
binds every one of the 353 public functions, so nothing is pruned. Reproduce with
`deno task bench:gleam-stdlib <checkout> <entry.gleam>`. Same machine as above; Gleam 1.17.0.

| Compiler                          | Cold, whole process |
| --------------------------------- | ------------------: |
| `gleam build --target javascript` |              146 ms |
| gpufuck                           |            4,890 ms |

**gpufuck is ~33x slower**, and it is doing strictly less: Gleam typechecks _and_ emits 49
JavaScript files to disk, while gpufuck writes nothing and its Gleam frontend covers a subset of the
language. Gleam's warm incremental build is 23 ms.

Where gpufuck's time goes (medians of 9, 49,964 surface nodes):

| Phase                               |       Median |   Share |
| ----------------------------------- | -----------: | ------: |
| Parse (baba)                        |        83 ms |      2% |
| Lower to surface                    |        67 ms |      2% |
| **GPU name resolution + inference** | **3,806 ms** | **96%** |
| Emit WebAssembly (1.7 MB)           |        25 ms |      1% |
| WebGPU device and pipeline setup    |       250 ms |       — |

The GPU phase alone is **26x Gleam's entire build**. This is the same defect the table above
records, seen without batching to hide it: the resolve-and-infer kernel is one lane running a serial
state machine, so a 49,964-node module is 49,964 sequential transitions on a single GPU thread — the
worst possible shape for the hardware. Batch throughput was 9.7x slower than the CPU;
single-large-module latency is 33x, because there is nothing to amortize the per-transition cost
against.

Note the inversion against the synthetic corpus: there, parsing was 74% of the CPU path and the
Amdahl ceiling was the story. Here parsing is 2%. On real input the GPU phase _is_ the cost, so the
ceiling argument does not apply and node-level parallelism is worth the whole budget.

Two measurement traps this benchmark hit, recorded so the next person does not:

- Lowering prunes to what the entry reaches. A small `main` lowered 252 KB of Gleam to **66 surface
  nodes** and produced a meaningless 124 ms. The entry must root every export.
- `compileModuleToWasm` memoizes per module, so a median over repeats times a cache hit and reports
  0.8 ms for a 25 ms operation. Each sample needs a freshly compiled module.

## Kill criteria

The retarget is judged on the **GPU inference share**, not total wall time:

- Below **10.2 µs/module** it beats the single-threaded CPU it replaces.
- The honest bar is a multi-threaded host: `inferTypes` across 8 workers is ~1.3 µs/module.
- If node-parallel validation and constraint generation cannot bring 99.7 µs under ~30 µs, the
  remaining phases — unification and generalization — will not close the gap either, since they are
  strictly harder to parallelize. Retreat to module-level throughput at that point.
