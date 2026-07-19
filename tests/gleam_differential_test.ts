import { deepStrictEqual, ok } from "node:assert/strict";

import {
  type FunctionalWasmValue,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../functional.ts";
import { lowerGleamFunctionalSource } from "../gleam_functional.ts";

const GLEAM_SOURCE = `
pub fn wide_integer() -> Int {
  4_000_000_000 + 42
}

pub fn negative_division() -> Int {
  -7 / 3
}

pub fn negative_remainder() -> Int {
  -7 % 3
}

pub fn text_concatenation() -> String {
  "Zażółć " <> "🦆"
}

pub fn pattern_lowering() -> String {
  let #(first, second) = #(20, 22)
  case "gpu" <> "fuck" {
    "other" -> "wrong"
    "gpu" <> rest -> rest <> { first + second |> integer_to_text }
    _ -> "unreachable"
  }
}

fn integer_to_text(value: Int) -> String {
  case value {
    42 -> "42"
    _ -> "?"
  }
}
`;

const gleamVersion = await installedGleamVersion();

Deno.test({
  name: "gpufuck Wasm agrees with the official Gleam JavaScript backend",
  ignore: gleamVersion === null,
  fn: async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "gpufuck-gleam-differential-" });
    try {
      await Deno.mkdir(`${projectRoot}/src`);
      await Deno.writeTextFile(
        `${projectRoot}/gleam.toml`,
        `name = "gpufuck_differential"\nversion = "1.0.0"\ntarget = "javascript"\n`,
      );
      await Deno.writeTextFile(`${projectRoot}/src/main.gleam`, GLEAM_SOURCE);
      await runGleamBuild(projectRoot);
      const official = await import(
        `${
          new URL(`file://${projectRoot}/build/dev/javascript/gpufuck_differential/main.mjs`).href
        }?${crypto.randomUUID()}`
      ) as Record<string, () => unknown>;

      const device = await requestWebGpuDevice();
      try {
        const compiler = await GpuFunctionalCompiler.create(device);
        for (
          const [exportName, expectedKind] of [
            ["wide_integer", "integer"],
            ["negative_division", "integer"],
            ["negative_remainder", "integer"],
            ["text_concatenation", "text"],
            ["pattern_lowering", "text"],
          ] as const
        ) {
          const officialFunction = official[exportName];
          if (typeof officialFunction !== "function") {
            throw new Error(
              `Gleam ${gleamVersion} JavaScript output omitted export ${
                JSON.stringify(exportName)
              }`,
            );
          }
          const expected = officialFunction();
          const actual = await compileAndRun(compiler, exportName);
          deepStrictEqual(
            actual,
            { kind: expectedKind, value: expected },
            `${exportName} differed from Gleam ${gleamVersion}`,
          );
        }
      } finally {
        device.destroy();
      }
    } finally {
      await Deno.remove(projectRoot, { recursive: true });
    }
  },
});

async function compileAndRun(
  compiler: GpuFunctionalCompiler,
  exportName: string,
): Promise<FunctionalWasmValue> {
  const frontend = lowerGleamFunctionalSource("main", GLEAM_SOURCE, exportName);
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) throw new Error(`Gleam differential export ${exportName} did not lower`);
  const compilation = await compiler.compileModule(frontend.lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error(`Gleam differential export ${exportName} did not compile`);
  try {
    return (await runFunctionalWasmModule(compilation.module)).value;
  } finally {
    compilation.module.destroy();
  }
}

async function installedGleamVersion(): Promise<string | null> {
  try {
    const output = await new Deno.Command("gleam", {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) return null;
    return new TextDecoder().decode(output.stdout).trim();
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound || error instanceof Deno.errors.PermissionDenied ||
      error instanceof Deno.errors.NotCapable
    ) {
      return null;
    }
    throw error;
  }
}

async function runGleamBuild(projectRoot: string): Promise<void> {
  const output = await new Deno.Command("gleam", {
    args: ["build", "--target", "javascript"],
    cwd: projectRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.success) return;
  throw new Error(
    `Gleam ${gleamVersion} JavaScript build failed with exit code ${output.code}: ${
      new TextDecoder().decode(output.stderr).trim()
    }`,
  );
}
