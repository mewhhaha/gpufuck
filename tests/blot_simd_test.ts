import { deepStrictEqual, equal, ok } from "node:assert/strict";

import { build, runLowering } from "../playground/blot/src/backend/compile.ts";
import { configureSources } from "../playground/blot/src/load.ts";
import { initializeBlotParser } from "../playground/blot/src/syntax/parse.ts";

const EXAMPLES = [
  ["simd_arithmetic.blot", 100n],
  ["simd_functions.blot", 40n],
] as const;

Deno.test("online Blot SIMD examples execute and emit native vector instructions", async () => {
  const blot = new URL("../playground/blot/", import.meta.url);
  await initializeBlotParser(
    new URL("generated/wasm/parser.wasm", blot),
    new URL("generated/wasm/parser.plan", blot),
  );
  const sources: Record<string, string> = {
    "/blot/prelude.blot": await Deno.readTextFile(
      new URL("src/prelude/prelude.blot", blot),
    ),
  };
  for (const [file] of EXAMPLES) {
    sources[`/examples/${file}`] = await Deno.readTextFile(
      new URL(`examples/${file}`, blot),
    );
  }
  configureSources(sources);

  for (const [file, expected] of EXAMPLES) {
    const path = `/examples/${file}`;
    deepStrictEqual(await runLowering(path), {
      kind: "signed-integer-64",
      value: expected,
    });
    const artifact = await build(path);
    const wasm = new Uint8Array(artifact.wasm);
    equal(WebAssembly.validate(wasm), true);
    ok(wasm.includes(0xfd), `${file} omitted Wasm SIMD instructions`);
  }
});

Deno.test("Blot canonical exports avoid arena-backed global thunks", async () => {
  const blot = new URL("../playground/blot/", import.meta.url);
  await initializeBlotParser(
    new URL("generated/wasm/parser.wasm", blot),
    new URL("generated/wasm/parser.plan", blot),
  );
  const path = "/examples/canonical-exports.blot";
  configureSources({
    "/blot/prelude.blot": await Deno.readTextFile(
      new URL("src/prelude/prelude.blot", blot),
    ),
    [path]: [
      'open {} = (@import "blot:prelude") ();',
      "return { .answer = 42; .double = value => value * 2; };",
    ].join("\n"),
  });

  const artifact = await build(path);
  const answer = artifact.manifest.exports.find((entry) => entry.sourceName === "answer");
  const double = artifact.manifest.exports.find((entry) => entry.sourceName === "double");
  deepStrictEqual(answer?.function?.parameters, []);
  deepStrictEqual(double?.function?.parameters, [{ kind: "signed-integer-64" }]);

  const { instance } = await WebAssembly.instantiate(new Uint8Array(artifact.wasm));
  const answerExport = instance.exports["blot:answer"];
  const doubleExport = instance.exports["blot:double"];
  ok(typeof answerExport === "function");
  ok(typeof doubleExport === "function");
  equal(answerExport(), 42n);
  equal(doubleExport(21n), 42n);
});
