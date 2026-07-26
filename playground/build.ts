/**
 * Builds the browser playground into `playground/dist`.
 *
 * `deno bundle` compiles the whole compiler for the browser, so the playground needs no npm
 * dependency, bundler config, or framework. The previous playground carried React, Vite, Babel, and
 * 258 MB of `node_modules` to do the same job.
 */
const root = new URL("../", import.meta.url);
const out = new URL("dist/", import.meta.url);

async function copy(from: URL, to: string): Promise<number> {
  const bytes = await Deno.readFile(from);
  await Deno.writeFile(new URL(to, out), bytes);
  return bytes.byteLength;
}

await Deno.remove(out, { recursive: true }).catch(() => {});
await Deno.mkdir(out, { recursive: true });

// Examples are inlined so the page needs no fetch waterfall to become interactive. Only top-level
// files are taken: `kernel/` is the multi-module sample, and the page has one textarea.
const exampleDirectory = new URL("examples/gleam/", root);
const names: string[] = [];
for await (const entry of Deno.readDir(exampleDirectory)) {
  if (entry.isFile && entry.name.endsWith(".gleam")) names.push(entry.name);
}
names.sort();
const examples = await Promise.all(names.map(async (name) => ({
  name: name.replace(/\.gleam$/, "").replaceAll("_", " ").replaceAll("-", " "),
  source: await Deno.readTextFile(new URL(name, exampleDirectory)),
})));
await Deno.writeTextFile(new URL("examples.json", out), JSON.stringify(examples));

const bundle = new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--platform",
    "browser",
    "--minify",
    "--output",
    new URL("main.js", out).pathname,
    new URL("main.ts", import.meta.url).pathname,
  ],
  stdout: "inherit",
  stderr: "inherit",
}).outputSync();
if (!bundle.success) throw new Error("deno bundle failed");

const parserBytes = await copy(
  new URL("language/gleam/generated/wasm/parser.wasm", root),
  "parser.wasm",
);
await copy(new URL("language/gleam/generated/wasm/parser.plan", root), "parser.plan");
await copy(new URL("index.html", import.meta.url), "index.html");
await copy(new URL("styles.css", import.meta.url), "styles.css");

const bundleBytes = (await Deno.stat(new URL("main.js", out))).size;
console.log(
  `playground/dist: ${examples.length} examples, bundle ${(bundleBytes / 1024).toFixed(0)}KB, ` +
    `parser ${(parserBytes / 1024).toFixed(0)}KB`,
);
