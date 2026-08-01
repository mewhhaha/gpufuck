import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BinaryOperator,
  buildSurfaceModule,
  type CanonicalAbiInterface,
  compileModuleToComponentBoundary,
  ComponentReloadSlot,
  CpuCompiler,
  surface,
} from "../functional.ts";

interface CalculatorExports {
  add(left: bigint, right: bigint): bigint;
}

const outputDirectory = Deno.args[0];
const wasmTools = Deno.env.get("GPUFUCK_WASM_TOOLS") ?? "wasm-tools";
const wasmtime = Deno.env.get("GPUFUCK_WASMTIME") ?? "wasmtime";
if (outputDirectory === undefined) {
  throw new TypeError("component verification requires an output directory argument");
}

const signedInteger64 = { kind: "signed-integer-64" as const };
const canonicalAbi: CanonicalAbiInterface = {
  version: 1,
  imports: [],
  exports: [{
    name: "add",
    function: {
      parameters: [signedInteger64, signedInteger64],
      result: signedInteger64,
    },
  }],
};
const versions: {
  readonly wit: string;
  readonly exports: CalculatorExports;
}[] = [];
await Deno.mkdir(outputDirectory, { recursive: true });

for (const fixture of [{ name: "v1", offset: 0n }, { name: "v2", offset: 1n }]) {
  const sum = surface.binary(
    BinaryOperator.AddSignedInteger64,
    surface.name("left"),
    surface.name("right"),
  );
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      {
        name: "add",
        parameters: ["left", "right"],
        annotation: {
          kind: "function",
          parameter: signedInteger64,
          result: { kind: "function", parameter: signedInteger64, result: signedInteger64 },
        },
        body: fixture.offset === 0n ? sum : surface.binary(
          BinaryOperator.AddSignedInteger64,
          sum,
          surface.signedInteger64(fixture.offset),
        ),
      },
    ],
    [],
    "main",
    0,
    { wasmExports: [{ name: "add", definition: "add" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);

  try {
    const artifact = await compileModuleToComponentBoundary(compilation.module, canonicalAbi, {
      packageName: "mewhhaha:gpufuck-verification@1.0.0",
      worldName: "calculator",
    });
    const corePath = join(outputDirectory, `calculator.${fixture.name}.core.wasm`);
    const witPath = join(outputDirectory, `calculator.${fixture.name}.wit`);
    const embeddedPath = join(outputDirectory, `calculator.${fixture.name}.embedded.wasm`);
    const componentPath = join(outputDirectory, `calculator.${fixture.name}.component.wasm`);
    const extractedWitPath = join(outputDirectory, `calculator.${fixture.name}.extracted.wit`);
    const jcoDirectory = join(outputDirectory, `jco-${fixture.name}`);
    await Deno.writeFile(corePath, artifact.coreWasm);
    await Deno.writeTextFile(witPath, artifact.wit);
    await runCommand(wasmTools, ["component", "embed", witPath, corePath, "-o", embeddedPath]);
    await runCommand(wasmTools, ["component", "new", embeddedPath, "-o", componentPath]);
    const extractedWit = await runCommand(wasmTools, ["component", "wit", componentPath]);
    await Deno.writeTextFile(extractedWitPath, extractedWit);
    const expected = 42n + fixture.offset;
    const wasmtimeOutput = await runCommand(wasmtime, [
      "run",
      "--invoke",
      "add(20, 22)",
      componentPath,
    ]);
    if (!wasmtimeOutput.includes(String(expected))) {
      throw new Error(
        `Wasmtime ${fixture.name} invocation returned ${JSON.stringify(wasmtimeOutput)}`,
      );
    }
    await runCommand("npx", [
      "--yes",
      "@bytecodealliance/jco@1.26.1",
      "transpile",
      componentPath,
      "-o",
      jcoDirectory,
    ]);
    const transpiled = await import(
      pathToFileURL(join(jcoDirectory, `calculator.${fixture.name}.component.js`)).href
    );
    if (typeof transpiled.add !== "function") {
      throw new Error(
        `jco ${fixture.name} output omitted add; exported ${Object.keys(transpiled).join(", ")}`,
      );
    }
    if (transpiled.add(20n, 22n) !== expected) {
      throw new Error(`jco ${fixture.name} component invocation returned an unexpected sum`);
    }
    versions.push({ wit: artifact.wit, exports: { add: transpiled.add } });
  } finally {
    compilation.module.destroy();
  }
}

const first = versions[0];
const second = versions[1];
if (first === undefined || second === undefined) {
  throw new Error(`component verification built ${versions.length} versions; expected 2`);
}
const slot = new ComponentReloadSlot(first);
const hostState = { total: 0n };
hostState.total = await slot.call((calculator) => calculator.add(hostState.total, 1n));
await slot.replace(second, (calculator) => {
  const candidateResult = calculator.add(20n, 22n);
  if (candidateResult !== 43n) {
    throw new Error(`component reload candidate health check returned ${candidateResult}`);
  }
});
hostState.total = await slot.call((calculator) => calculator.add(hostState.total, 1n));
if (hostState.total !== 3n) {
  throw new Error(`component reload lost host state; received ${hostState.total}`);
}
console.log(`verified two Component versions and hot reload in ${outputDirectory}`);

async function runCommand(executable: string, arguments_: readonly string[]): Promise<string> {
  const command = new Deno.Command(executable, {
    args: [...arguments_],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const stdout = new TextDecoder().decode(result.stdout);
  if (result.success) return stdout;
  const stderr = new TextDecoder().decode(result.stderr);
  throw new Error(
    `command ${JSON.stringify(executable)} ${
      arguments_.map((argument) => JSON.stringify(argument)).join(" ")
    } failed with ${result.code}: ${stderr}`,
  );
}
