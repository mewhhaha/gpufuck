const projectRoot = Deno.cwd();
const generatedRoot = `${projectRoot}/language/lazuli/generated`;
const helixConfig = helixConfigDirectory();
const helixRuntime = `${helixConfig}/runtime`;
const languagesPath = `${helixConfig}/languages.toml`;
const grammarSource = `${generatedRoot}/tree-sitter/lazuli.${libraryExtension()}`;
const grammarTarget = `${helixRuntime}/grammars/lazuli.${libraryExtension()}`;
const queryTarget = `${helixRuntime}/queries/lazuli`;
const blockStart = "# >>> lazuli (managed by gpufuck just install) >>>";
const blockEnd = "# <<< lazuli (managed by gpufuck just install) <<<";

await installGrammar();
await installQueries();
await installLanguageConfig();

console.log(`Installed Lazuli Helix grammar to ${grammarTarget}`);
console.log(`Installed Lazuli Helix queries to ${queryTarget}`);
console.log(`Installed Lazuli language config to ${languagesPath}`);

async function installGrammar(): Promise<void> {
  await assertFile(grammarSource);
  await Deno.mkdir(`${helixRuntime}/grammars`, { recursive: true });
  await Deno.copyFile(grammarSource, grammarTarget);
}

async function installQueries(): Promise<void> {
  await removeDirectory(queryTarget);
  await Deno.mkdir(queryTarget, { recursive: true });
  await Deno.copyFile(
    `${generatedRoot}/queries/generated-highlights.scm`,
    `${queryTarget}/highlights.scm`,
  );
  await Deno.copyFile(
    `${generatedRoot}/queries/generated-rainbows.scm`,
    `${queryTarget}/rainbows.scm`,
  );
}

async function installLanguageConfig(): Promise<void> {
  await Deno.mkdir(helixConfig, { recursive: true });
  const existing = await Deno.readTextFile(languagesPath).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return "";
    throw error;
  });
  const block = [
    blockStart,
    "[[language]]",
    'name = "lazuli"',
    'scope = "source.lazuli"',
    'injection-regex = "lazuli"',
    'file-types = ["lz"]',
    'roots = ["deno.json", ".git"]',
    'comment-tokens = "--"',
    'grammar = "lazuli"',
    "rainbow-brackets = true",
    'indent = { tab-width = 2, unit = "  " }',
    "",
    "[[grammar]]",
    'name = "lazuli"',
    `source = { path = ${JSON.stringify(`${generatedRoot}/tree-sitter`)} }`,
    blockEnd,
  ].join("\n");

  await Deno.writeTextFile(languagesPath, replaceManagedBlock(existing, block));
}

function replaceManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(blockStart);
  const end = existing.indexOf(blockEnd);

  if ((start === -1) !== (end === -1) || start > end) {
    throw new Error(
      `${languagesPath} contains an incomplete Lazuli managed block: start=${start}, end=${end}`,
    );
  }
  if (start !== -1) {
    const afterEnd = end + blockEnd.length;
    const next = existing.slice(afterEnd).startsWith("\n") ? afterEnd + 1 : afterEnd;
    return `${existing.slice(0, start)}${block}\n${existing.slice(next)}`;
  }

  const prefix = existing.trimEnd();
  if (prefix.length === 0) return `${block}\n`;
  return `${prefix}\n\n${block}\n`;
}

async function removeDirectory(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function assertFile(path: string): Promise<void> {
  const file = await Deno.stat(path);
  if (!file.isFile) throw new Error(`${path} is not a file`);
}

function helixConfigDirectory(): string {
  const xdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
  if (xdgConfigHome !== undefined && xdgConfigHome.length > 0) {
    return `${xdgConfigHome}/helix`;
  }

  const home = Deno.env.get("HOME");
  if (home === undefined || home.length === 0) {
    throw new Error("HOME must be set when XDG_CONFIG_HOME is unset");
  }
  return `${home}/.config/helix`;
}

function libraryExtension(): string {
  if (Deno.build.os === "windows") return "dll";
  if (Deno.build.os === "darwin") return "dylib";
  return "so";
}
