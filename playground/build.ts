/** Builds the self-contained Blot browser playground into `playground/dist`. */
const out = new URL("dist/", import.meta.url);
const blot = new URL("blot/", import.meta.url);

async function copy(from: URL, to: string): Promise<number> {
  const bytes = await Deno.readFile(from);
  await Deno.writeFile(new URL(to, out), bytes);
  return bytes.byteLength;
}

await Deno.remove(out, { recursive: true }).catch(() => {});
await Deno.mkdir(out, { recursive: true });

const featured = [
  "tour.blot",
  "effects.blot",
  "linear.blot",
  "loops.blot",
  "types.blot",
  "storage.blot",
  "matching.blot",
  "modules.blot",
  "compiled.blot",
] as const;

const sources: Record<string, string> = {
  "/blot/prelude.blot": await Deno.readTextFile(new URL("src/prelude/prelude.blot", blot)),
};
for await (const entry of Deno.readDir(new URL("examples/", blot))) {
  if (entry.isFile && entry.name.endsWith(".blot")) {
    sources[`/examples/${entry.name}`] = await Deno.readTextFile(
      new URL(`examples/${entry.name}`, blot),
    );
  }
}
for await (const entry of Deno.readDir(new URL("examples/lib/", blot))) {
  if (entry.isFile && entry.name.endsWith(".blot")) {
    sources[`/examples/lib/${entry.name}`] = await Deno.readTextFile(
      new URL(`examples/lib/${entry.name}`, blot),
    );
  }
}

const examples = featured.map((file) => ({
  name: file.replace(/\.blot$/, "").replaceAll("_", " "),
  path: `/examples/${file}`,
  source: sources[`/examples/${file}`]!,
}));
await Deno.writeTextFile(
  new URL("examples.json", out),
  JSON.stringify({ examples, sources }),
);

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
if (!bundle.success) throw new Error("deno bundle failed for playground/main.ts");

const parserBytes = await copy(
  new URL("generated/wasm/parser.wasm", blot),
  "parser.wasm",
);
const planBytes = await copy(
  new URL("generated/wasm/parser.plan", blot),
  "parser.plan",
);
await copy(new URL("index.html", import.meta.url), "index.html");
await copy(new URL("styles.css", import.meta.url), "styles.css");

const bundleBytes = (await Deno.stat(new URL("main.js", out))).size;
console.log(
  `playground/dist: ${examples.length} Blot examples, bundle ${
    (bundleBytes / 1024).toFixed(0)
  }KB, parser ${(parserBytes / 1024).toFixed(0)}KB, plan ${(planBytes / 1024).toFixed(0)}KB`,
);
