import { equal, notStrictEqual, ok, strictEqual } from "node:assert/strict";

import { validateLowering } from "../playground/blot/src/backend/compile.ts";
import {
  configureSourceLexerRecords,
  configureSources,
  load,
} from "../playground/blot/src/load.ts";
import { initializeBlotParser } from "../playground/blot/src/syntax/parse.ts";
import { createBlotStressProject } from "../playground/blot/stress_project.ts";
import { resetBlotSyntaxSession, validateBlotSyntax } from "../playground/blot/gpu_frontend.ts";

Deno.test("Blot stress project keeps every module reachable through a runtime export", async () => {
  const blot = new URL("../playground/blot/", import.meta.url);
  await initializeBlotParser(
    new URL("generated/wasm/parser.wasm", blot),
    new URL("generated/wasm/parser.plan", blot),
  );
  const project = createBlotStressProject();
  configureSources({
    "/blot/prelude.blot": await Deno.readTextFile(new URL("src/prelude/prelude.blot", blot)),
    ...project.sources,
  });

  const manifest = await validateLowering(project.entryPath);
  equal(
    manifest.exports.filter((entry) => entry.phase === "runtime").length,
    project.moduleCount - 1,
  );
});

Deno.test("Blot source cache invalidates an edited importer but preserves its dependency", async () => {
  const blot = new URL("../playground/blot/", import.meta.url);
  await initializeBlotParser(
    new URL("generated/wasm/parser.wasm", blot),
    new URL("generated/wasm/parser.plan", blot),
  );
  const prelude = await Deno.readTextFile(new URL("src/prelude/prelude.blot", blot));
  const path = "/examples/cache.blot";
  const source = 'open {} = (@import "blot:prelude") ();\nreturn 42;\n';
  configureSources({ "/blot/prelude.blot": prelude, [path]: source });
  const first = await load(path);
  const firstPrelude = first.dependencies.get("blot:prelude");

  configureSources(
    { "/blot/prelude.blot": prelude, [path]: `${source}// edited\n` },
    { cache: "reuse-unchanged" },
  );
  const second = await load(path);
  const secondPrelude = second.dependencies.get("blot:prelude");

  notStrictEqual(second, first);
  strictEqual(secondPrelude, firstPrelude);
  equal(second.source.endsWith("// edited\n"), true);
});

Deno.test("Blot cursor parser consumes lexer records produced by the GPU frontend", async () => {
  const blot = new URL("../playground/blot/", import.meta.url);
  const parserPlan = new URL("generated/wasm/parser.plan", blot);
  await initializeBlotParser(
    new URL("generated/wasm/parser.wasm", blot),
    parserPlan,
  );
  const source = "return 42;\n";
  try {
    const syntax = await validateBlotSyntax(source, parserPlan);
    ok(syntax.ok, syntax.ok ? undefined : syntax.diagnostics[0]?.message);
    if (!syntax.ok) return;
    const path = "/examples/gpu-lexer-records.blot";
    configureSources({ [path]: source });
    configureSourceLexerRecords(path, source, syntax.lexerRecords);
    const loaded = await load(path);
    equal(loaded.path, path);
    equal(loaded.module.result.tag, "int");
  } finally {
    await resetBlotSyntaxSession();
  }
});
