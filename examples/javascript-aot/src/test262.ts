export interface Test262NegativeExpectation {
  readonly phase: "parse" | "resolution" | "runtime";
  readonly type: string;
}

export interface Test262Metadata {
  readonly flags: readonly string[];
  readonly features: readonly string[];
  readonly includes: readonly string[];
  readonly negative: Test262NegativeExpectation | null;
}

export type Test262CoreDisposition =
  | { readonly kind: "applicable" }
  | { readonly kind: "excluded"; readonly reason: "dynamic-code-generation" }
  | { readonly kind: "fixture" };

export type Test262ExecutionMode = "non-strict" | "strict" | "module" | "raw";

export function parseTest262Metadata(path: string, source: string): Test262Metadata {
  const start = source.indexOf("/*---");
  const end = source.indexOf("---*/", start + 5);
  if (start < 0 || end < 0) {
    throw new Error(`Test262 file ${JSON.stringify(path)} has no complete metadata block.`);
  }

  const lines = source.slice(start + 5, end).split(/\r?\n/);
  const flags = readStringList(lines, "flags");
  const features = readStringList(lines, "features");
  const includes = readStringList(lines, "includes");
  const negative = readNegativeExpectation(path, lines);
  return { flags, features, includes, negative };
}

export function classifyTest262CoreTest(
  relativePath: string,
): Test262CoreDisposition {
  if (!relativePath.startsWith("test/language/")) {
    throw new Error(
      `Test262 core path ${JSON.stringify(relativePath)} is outside test/language.`,
    );
  }
  if (relativePath.endsWith("_FIXTURE.js")) return { kind: "fixture" };
  if (relativePath.startsWith("test/language/eval-code/")) {
    return { kind: "excluded", reason: "dynamic-code-generation" };
  }
  return { kind: "applicable" };
}

export function test262ExecutionModes(
  metadata: Test262Metadata,
): readonly Test262ExecutionMode[] {
  if (metadata.flags.includes("raw")) return ["raw"];
  if (metadata.flags.includes("module")) return ["module"];
  if (metadata.flags.includes("onlyStrict")) return ["strict"];
  if (metadata.flags.includes("noStrict")) return ["non-strict"];
  return ["non-strict", "strict"];
}

export function test262FrontendProbeSource(
  source: string,
  metadata: Test262Metadata,
  entryName: string,
  mode: Test262ExecutionMode,
): string | null {
  if (metadata.negative !== null) return null;
  const body = removeMetadataBlock(source);
  if (mode === "module") {
    return `${body}\nexport function ${entryName}() { return true; }\n`;
  }
  const directive = mode === "strict" ? '"use strict";\n' : "";
  return `export function ${entryName}() {\n${directive}${body}\nreturn true;\n}\n`;
}

function removeMetadataBlock(source: string): string {
  const start = source.indexOf("/*---");
  const end = source.indexOf("---*/", start + 5);
  if (start < 0 || end < 0) return source;
  return source.slice(0, start) + source.slice(end + 5);
}

function readStringList(lines: readonly string[], key: string): readonly string[] {
  const keyIndex = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (keyIndex < 0) return [];
  const value = lines[keyIndex]!.slice(key.length + 1).trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const contents = value.slice(1, -1).trim();
    if (contents.length === 0) return [];
    return contents.split(",").map((entry) => unquote(entry.trim()));
  }
  if (value.length > 0) return [unquote(value)];

  const entries: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index++) {
    const match = /^\s+-\s+(.+?)\s*$/.exec(lines[index]!);
    if (match === null) break;
    entries.push(unquote(match[1]!));
  }
  return entries;
}

function readNegativeExpectation(
  path: string,
  lines: readonly string[],
): Test262NegativeExpectation | null {
  const negativeIndex = lines.findIndex((line) => line === "negative:");
  if (negativeIndex < 0) return null;
  let phase: string | undefined;
  let type: string | undefined;
  for (let index = negativeIndex + 1; index < lines.length; index++) {
    const match = /^\s+([a-z]+):\s*(.+?)\s*$/.exec(lines[index]!);
    if (match === null) break;
    if (match[1] === "phase") phase = unquote(match[2]!);
    if (match[1] === "type") type = unquote(match[2]!);
  }
  if (phase !== "parse" && phase !== "resolution" && phase !== "runtime") {
    throw new Error(
      `Test262 file ${JSON.stringify(path)} has unsupported negative phase ${
        JSON.stringify(phase)
      }.`,
    );
  }
  if (type === undefined || type.length === 0) {
    throw new Error(
      `Test262 file ${JSON.stringify(path)} has a negative test without an error type.`,
    );
  }
  return { phase, type };
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
