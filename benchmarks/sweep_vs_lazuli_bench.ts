/**
 * Does designing a language for the pipeline actually pay?
 *
 * The same computation in Sweep and in Lazuli, scaled by repetition count, measuring surface nodes
 * and GPU inference transitions. DESIGN.md predicts 2–4x on inference from language choices alone,
 * with the caveat that rules 1 and 3 need backend work this cannot exercise: the engine still
 * solves rather than checks, and Core arrows are still unary. So this measures the frontend half of
 * the design and nothing more.
 *
 * Usage: deno task bench:sweep
 */
import { requestWebGpuDevice } from "../functional.ts";
import { GpuSemanticCompiler } from "../src/semantic/gpu_semantic_compiler.ts";
import type { GpuCompilationDispatchObservation } from "../src/semantic/gpu_type_inference_contract.ts";
import { parseLazuliSource } from "../src/lazuli/frontend.ts";
import { lazuliSurfaceToModule } from "../src/lazuli/functional_adapter.ts";
import { compileSweepSource } from "../sweep.ts";

const sweepSource = (n: number) =>
  `type Shape = Circle(radius: Int) | Rect(width: Int, height: Int);

${
    Array.from(
      { length: n },
      (_, i) =>
        `fn area${i}(s: Shape) -> Int =\n  match s {\n    Circle(r) -> ${
          i + 1
        } * r * r;\n    Rect(w, h) -> w * h;\n  };`,
    ).join("\n\n")
  }

fn main() -> Int = ${Array.from({ length: n }, (_, i) => `area${i}(Rect(2, 3))`).join(" + ")};
`;

const lazuliSource = (n: number) =>
  `data Shape = Circle(radius: Int) | Rect(width: Int, height: Int);

${
    Array.from({ length: n }, (_, i) =>
      `let area${i} = s =>\n  case s of\n    | Circle(r) -> ${
        i + 1
      } * r * r\n    | Rect(w, h) -> w * h\n  end;`).join("\n\n")
  }

fn main = ${Array.from({ length: n }, (_, i) => `area${i} (Rect 2 3)`).join(" + ")};
`;

const device = await requestWebGpuDevice();
const compiler = await GpuSemanticCompiler.create(device);

async function measure(
  surfaceModule: { nodeCount: number; sourceByteLength: number },
  encoded: Parameters<typeof compiler.compile>[0],
) {
  let transitions = 0;
  const result = await compiler.compile(
    encoded,
    surfaceModule.sourceByteLength,
    { maximumSteps: 10_000_000, maximumStepsPerDispatch: 524_288 },
    undefined,
    {
      observeDispatch: (o: GpuCompilationDispatchObservation) => {
        transitions = Math.max(transitions, o.inferenceTransitions);
      },
    },
  );
  if (!result.ok) {
    throw new Error(`${result.diagnostics[0]!.code}: ${result.diagnostics[0]!.message}`);
  }
  result.module.destroy();
  return transitions;
}

console.log(
  "functions   sweep nodes  lazuli nodes   sweep trans  lazuli trans   node ratio  trans ratio",
);
for (const n of [4, 16, 64]) {
  const sweep = compileSweepSource("bench", sweepSource(n));
  if (!sweep.ok) throw new Error(`sweep: ${sweep.diagnostics[0]!.message}`);
  const source = lazuliSource(n);
  const parsed = parseLazuliSource(source);
  if (!parsed.ok) throw new Error(`lazuli parse failed: ${parsed.diagnostics[0]!.message}`);
  const lazuli = lazuliSurfaceToModule(parsed.surface, new TextEncoder().encode(source).byteLength);

  const sweepTransitions = await measure(sweep.module, sweep.module);
  const lazuliTransitions = await measure(lazuli, lazuli);
  console.log(
    `${String(n).padStart(9)} ${String(sweep.module.nodeCount).padStart(12)} ${
      String(lazuli.nodeCount).padStart(13)
    } ${String(sweepTransitions).padStart(13)} ${String(lazuliTransitions).padStart(13)} ${
      (lazuli.nodeCount / sweep.module.nodeCount).toFixed(2).padStart(12)
    }x ${(lazuliTransitions / sweepTransitions).toFixed(2).padStart(11)}x`,
  );
}
device.destroy();
