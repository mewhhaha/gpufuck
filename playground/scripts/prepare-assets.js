import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const generatedRoot = fileURLToPath(new URL("../public/generated/", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "examples", "lazuli");

await rm(generatedRoot, { force: true, recursive: true });
await mkdir(path.join(generatedRoot, "sources"), { recursive: true });

await Promise.all([
  cp(
    path.join(repositoryRoot, "language/lazuli/generated/wasm/parser.wasm"),
    path.join(generatedRoot, "lazuli-parser.wasm"),
  ),
  cp(
    path.join(repositoryRoot, "language/lazuli/generated/wasm/parser.plan"),
    path.join(generatedRoot, "lazuli-parser.plan"),
  ),
]);

const sourceNames = (await readdir(sourceRoot))
  .filter((sourceName) => sourceName.endsWith(".laz"))
  .sort();
if (sourceNames.length === 0) {
  throw new Error(`browser playground found no Lazuli examples under ${sourceRoot}`);
}

const manifest = [];
for (const sourceName of sourceNames) {
  await cp(path.join(sourceRoot, sourceName), path.join(generatedRoot, "sources", sourceName));
  manifest.push({
    name: sourceName.slice(0, -4).replaceAll("-", " "),
    path: `generated/sources/${sourceName}`,
  });
}

await writeFile(
  path.join(generatedRoot, "examples.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
