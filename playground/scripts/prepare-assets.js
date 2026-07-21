import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const generatedRoot = fileURLToPath(new URL("../public/generated/", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "examples", "lazuli");
const massiveBindingCount = 2_048;
const massiveBindingsPerDefinition = 128;
const massiveSourceName = "massive-2048-bindings.laz";

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

const massiveChunkDefinitions = [];
for (
  let firstBinding = 0;
  firstBinding < massiveBindingCount;
  firstBinding += massiveBindingsPerDefinition
) {
  const chunkIndex = firstBinding / massiveBindingsPerDefinition;
  const chunkName = `massiveChunk${chunkIndex.toString().padStart(2, "0")}`;
  const bindingCount = Math.min(massiveBindingsPerDefinition, massiveBindingCount - firstBinding);
  const bindings = Array.from({ length: bindingCount }, (_, offset) => {
    const index = firstBinding + offset;
    const name = `massive${index.toString().padStart(4, "0")}`;
    if (index === 0) return `  let ${name} = 1 in`;
    const previousName =
      offset === 0
        ? `massiveChunk${(chunkIndex - 1).toString().padStart(2, "0")}`
        : `massive${(index - 1).toString().padStart(4, "0")}`;
    return `  let ${name} = ${previousName} + 1 in`;
  });
  const lastBinding = firstBinding + bindingCount - 1;
  massiveChunkDefinitions.push(
    [`fn ${chunkName} =`, ...bindings, `  massive${lastBinding.toString().padStart(4, "0")};`].join(
      "\n",
    ),
  );
}
const massiveSource = [
  `-- Generated browser stress example with ${massiveBindingCount.toLocaleString("en-US")} dependent local bindings.`,
  ...massiveChunkDefinitions,
  `fn main = massiveChunk${(massiveChunkDefinitions.length - 1).toString().padStart(2, "0")};`,
  "",
].join("\n");
await writeFile(path.join(generatedRoot, "sources", massiveSourceName), massiveSource);
manifest.push({
  name: `massive · ${massiveBindingCount.toLocaleString("en-US")} bindings`,
  path: `generated/sources/${massiveSourceName}`,
});

await writeFile(
  path.join(generatedRoot, "examples.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
