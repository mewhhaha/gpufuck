import { equal } from "node:assert/strict";

import { validateLowering } from "../playground/blot/src/backend/compile.ts";
import { configureSources } from "../playground/blot/src/load.ts";
import { initializeBlotParser } from "../playground/blot/src/syntax/parse.ts";
import { createBlotStressProject } from "../playground/blot/stress_project.ts";

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
