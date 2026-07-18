import { deepStrictEqual, equal, match, ok } from "node:assert/strict";

import {
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
} from "../functional.ts";
import {
  type GleamFunctionalSourceModule,
  type LoweredGleamFunctionalProgram,
  lowerGleamFunctionalSource,
  lowerGleamFunctionalSources,
  renderGleamFunctionalTrace,
} from "../gleam_functional.ts";

interface GleamFunctionalRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuFunctionalCompiler;
  readonly evaluator: GpuFunctionalEvaluator;
}

let runtime: GleamFunctionalRuntime | undefined;

Deno.test.beforeAll(async () => {
  const device = await requestWebGpuDevice();
  const [compiler, evaluator] = await Promise.all([
    GpuFunctionalCompiler.create(device),
    GpuFunctionalEvaluator.create(device),
  ]);
  runtime = { device, compiler, evaluator };
});

Deno.test.afterAll(() => {
  runtime?.device.destroy();
  runtime = undefined;
});

Deno.test("infers and evaluates a generic Gleam algebraic transformation", async () => {
  const evaluation = await evaluateSingleExample("examples/gleam-functional/option_map.gleam");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("infers a recursive higher-order Gleam list fold", async () => {
  const evaluation = await evaluateSingleExample("examples/gleam-functional/list_fold.gleam");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("desugars Gleam pipelines in source order", async () => {
  const evaluation = await evaluateSingleExample("examples/gleam-functional/pipeline.gleam");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("preserves labeled Gleam constructor fields through Baba parsing", async () => {
  const frontend = lowerGleamFunctionalSource(
    "labeled",
    `
pub type Box {
  Box(value: Int)
}

pub fn main() -> Int {
  case Box(value: 42) {
    Box(value: answer) -> answer
  }
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  const evaluation = await evaluate(frontend.lowered);
  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("links and evaluates a recursive three-module Gleam program", async () => {
  const sources = await readKernelSources();
  const lowered = requireLinked(sources, "kernel/main");
  const evaluation = await evaluate(lowered);

  deepStrictEqual(evaluation, { kind: "integer", value: 1_109_720 });
});

Deno.test("requires complete types on public Gleam module boundaries", () => {
  const frontend = lowerGleamFunctionalSource("boundary", `pub fn main(value) { value }\n`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "G1002");
  match(frontend.diagnostics[0].message, /must annotate every parameter and its result/);
});

Deno.test("maps Baba lexical failures to Gleam UTF-8 byte spans", () => {
  const source = `// λ\npub fn main() -> Int { @ }\n`;
  const frontend = lowerGleamFunctionalSource("invalid", source);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "G1001");
  const invalidByte = new TextEncoder().encode(source.slice(0, source.indexOf("@"))).byteLength;
  deepStrictEqual(frontend.diagnostics[0].span, {
    startByte: invalidByte,
    endByte: invalidByte + 1,
  });
  match(frontend.diagnostics[0].message, /PARSE_LEXICAL_ERROR/);
});

Deno.test("reports a missing imported Gleam function with its module name", () => {
  const frontend = lowerGleamFunctionalSources([
    { name: "library", source: `pub fn present(value: Int) -> Int { value }\n` },
    {
      name: "application",
      source: `import library.{missing}\npub fn main() -> Int { missing(42) }\n`,
    },
  ], { module: "application", exportName: "main" });

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].module, "application");
  match(frontend.diagnostics[0].message, /"library.missing"/);
});

Deno.test("rejects a constructor arm after a Gleam catch-all", () => {
  const frontend = lowerGleamFunctionalSource(
    "case_order",
    `
pub type Choice {
  First
  Second
}

pub fn main() -> Int {
  case First {
    _ -> 1
    Second -> 2
  }
}
`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /catch-all case arm must be last/);
});

Deno.test("renders linked Gleam source and both functional IR stages side by side", async () => {
  const sources = await readKernelSources();
  const lowered = requireLinked(sources, "kernel/main");
  const { compiler, evaluator } = gleamRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const trace = renderGleamFunctionalTrace({
      title: "linked kernel",
      source: sources.map((module) => `// ${module.name}\n${module.source}`).join("\n"),
      lowered,
      compiledModule: compilation.module,
      coreNodes: await compilation.module.readCoreNodes(),
      evaluation: await evaluator.evaluate(compilation.module),
    });

    match(trace, /Gleam source modules<\/th><th>Normalized functional surface/);
    match(trace, /Encoded functional ABI<\/th><th>GPU-resolved core IR/);
    match(trace, /kernel\/program::run/);
    match(trace, /"value": 1109720/);
  } finally {
    compilation.module.destroy();
  }
});

async function evaluateSingleExample(
  path: string,
): Promise<{ readonly kind: string; readonly value: unknown }> {
  const source = await Deno.readTextFile(path);
  const moduleName = path.split("/").at(-1)!.replace(".gleam", "");
  const frontend = lowerGleamFunctionalSource(moduleName, source);
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) throw new Error(`Gleam example ${JSON.stringify(path)} did not lower.`);
  return await evaluate(frontend.lowered);
}

async function evaluate(
  lowered: LoweredGleamFunctionalProgram,
): Promise<{ readonly kind: string; readonly value: unknown }> {
  const { compiler, evaluator } = gleamRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("Gleam example did not compile.");
  try {
    const evaluation = await evaluator.evaluate(compilation.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (!evaluation.ok) throw new Error("Gleam example did not evaluate.");
    if (
      evaluation.value.kind === "closure" || evaluation.value.kind === "unit" ||
      evaluation.value.kind === "constructor" || evaluation.value.kind === "tuple"
    ) {
      throw new Error(`Gleam example returned ${evaluation.value.kind}.`);
    }
    return evaluation.value;
  } finally {
    compilation.module.destroy();
  }
}

async function readKernelSources(): Promise<readonly GleamFunctionalSourceModule[]> {
  return await Promise.all(
    ["math", "program", "main"].map(async (name) => ({
      name: `kernel/${name}`,
      source: await Deno.readTextFile(`examples/gleam-functional/kernel/${name}.gleam`),
    })),
  );
}

function requireLinked(
  sources: readonly GleamFunctionalSourceModule[],
  entryModule: string,
): LoweredGleamFunctionalProgram {
  const frontend = lowerGleamFunctionalSources(sources, {
    module: entryModule,
    exportName: "main",
  });
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) throw new Error("Linked Gleam example did not lower.");
  return frontend.lowered;
}

function gleamRuntime(): GleamFunctionalRuntime {
  if (runtime === undefined) throw new Error("Gleam functional test runtime was not initialized");
  return runtime;
}
