import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const generatedRoot = fileURLToPath(new URL("../public/generated/", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "examples", "lazuli");
const massiveBindingCount = 2_048;
const massiveBindingsPerDefinition = 128;
const massiveSourceName = "massive-2048-bindings.laz";
const wideDefinitionCount = 1_500;
const wideSourceName = "wide-1500-definitions.laz";
const fanoutLeafCount = 1_024;
const fanoutWidth = 8;
const fanoutSourceName = "fanout-1024-leaves.laz";

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
const writeGeneratedExample = async (name, sourceName, source) => {
  await writeFile(path.join(generatedRoot, "sources", sourceName), source);
  manifest.push({ name, path: `generated/sources/${sourceName}` });
};
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
await writeGeneratedExample(
  `massive · ${massiveBindingCount.toLocaleString("en-US")} bindings`,
  massiveSourceName,
  massiveSource,
);

const wideSource = [
  `-- Generated browser stress example with ${wideDefinitionCount.toLocaleString("en-US")} independent definitions.`,
  ...Array.from(
    { length: wideDefinitionCount },
    (_, index) => `fn wide${index.toString().padStart(4, "0")} = ${index};`,
  ),
  `fn main = wide${(wideDefinitionCount - 1).toString().padStart(4, "0")};`,
  "",
].join("\n");
await writeGeneratedExample(
  `wide · ${wideDefinitionCount.toLocaleString("en-US")} definitions`,
  wideSourceName,
  wideSource,
);

const fanoutDefinitions = [];
let fanoutLevelNames = Array.from(
  { length: fanoutLeafCount },
  (_, index) => `fanoutLeaf${index.toString().padStart(4, "0")}`,
);
fanoutDefinitions.push(...fanoutLevelNames.map((name) => `fn ${name} = 1;`));
let fanoutLevel = 0;
while (fanoutLevelNames.length > 1) {
  const nextLevelNames = [];
  for (let first = 0; first < fanoutLevelNames.length; first += fanoutWidth) {
    const group = fanoutLevelNames.slice(first, first + fanoutWidth);
    const name = `fanout${fanoutLevel.toString().padStart(2, "0")}_${nextLevelNames.length
      .toString()
      .padStart(4, "0")}`;
    fanoutDefinitions.push(`fn ${name} = ${group.join(" + ")};`);
    nextLevelNames.push(name);
  }
  fanoutLevelNames = nextLevelNames;
  fanoutLevel += 1;
}
const fanoutSource = [
  `-- Generated browser stress example reducing ${fanoutLeafCount.toLocaleString("en-US")} independent leaves in ${fanoutWidth}-way layers.`,
  ...fanoutDefinitions,
  `fn main = ${fanoutLevelNames[0]};`,
  "",
].join("\n");
await writeGeneratedExample(
  `fanout · ${fanoutLeafCount.toLocaleString("en-US")} leaves`,
  fanoutSourceName,
  fanoutSource,
);

await writeFile(
  path.join(generatedRoot, "examples.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
