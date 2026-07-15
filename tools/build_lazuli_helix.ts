import {
  type GrammarDocument,
  type GrammarExpression,
  type GrammarRule,
  type GrammarTerminalPattern,
  type GrammarTokenDeclaration,
  parseGrammar,
} from "@mewhhaha/baba";

const grammarSource = await Deno.readTextFile("language/lazuli/grammar.baba");
const grammar = parseGrammar(grammarSource);
const outputDirectory = "language/lazuli/generated/tree-sitter";
const parserDirectory = `${outputDirectory}/src`;
const grammarPath = `${outputDirectory}/grammar.js`;
const grammarLibrary = `${outputDirectory}/lazuli.${libraryExtension()}`;

await Deno.mkdir(outputDirectory, { recursive: true });
await Deno.writeTextFile(grammarPath, renderTreeSitterGrammar(grammar));
await run("tree-sitter", [
  "generate",
  "--abi",
  "14",
  grammarPath,
  "--output",
  parserDirectory,
]);
await run("tree-sitter", ["build", outputDirectory, "--output", grammarLibrary]);

console.log(`Built ${grammarLibrary}`);

function renderTreeSitterGrammar(grammar: GrammarDocument): string {
  const lines = [
    "// Generated from language/lazuli/grammar.baba. Do not edit by hand.",
    "export default grammar({",
    '  name: "lazuli",',
    "",
  ];
  const tokens = grammarTokenDeclarations(grammar);
  const skips = tokens.filter((token) => token.kind === "skip");

  if (skips.length > 0) {
    lines.push(
      "  extras: $ => [",
      ...skips.map((token) => `    $.${token.name},`),
      "  ],",
      "",
    );
  }

  lines.push(
    "  conflicts: $ => [",
    "    [$.type_atom, $.const_descriptor],",
    "  ],",
    "",
  );
  lines.push("  rules: {", "    source_file: $ => $.module,");
  for (const rule of grammarRuleDeclarations(grammar)) {
    lines.push(`    ${rule.name}: $ => ${renderTreeSitterExpression(rule.expression)},`);
  }
  for (const token of tokens) {
    const expression = renderTreeSitterTerminalPattern(token.pattern);
    const value = token.kind === "skip" ? expression : `token(${expression})`;
    lines.push(`    ${token.name}: $ => ${value},`);
  }
  lines.push("  },", "});", "");
  return lines.join("\n");
}

function grammarRuleDeclarations(grammar: GrammarDocument): GrammarRule[] {
  return grammar.declarations.filter((declaration): declaration is GrammarRule =>
    declaration.kind === "rule"
  );
}

function grammarTokenDeclarations(grammar: GrammarDocument): GrammarTokenDeclaration[] {
  const tokens: GrammarTokenDeclaration[] = [];
  for (const declaration of grammar.declarations) {
    if (isGrammarTokenDeclaration(declaration)) {
      tokens.push(declaration);
    } else if (declaration.kind === "mode") {
      tokens.push(...declaration.declarations);
    }
  }
  return tokens;
}

function isGrammarTokenDeclaration(
  declaration: GrammarDocument["declarations"][number],
): declaration is GrammarTokenDeclaration {
  return declaration.kind === "token" || declaration.kind === "skip" ||
    declaration.kind === "contextual";
}

function renderTreeSitterExpression(expression: GrammarExpression): string {
  switch (expression.kind) {
    case "field":
      return `field(${JSON.stringify(expression.name)}, ${
        renderTreeSitterExpression(expression.expression)
      })`;
    case "ref":
      return `$.${expression.name}`;
    case "literal":
      return JSON.stringify(expression.value);
    case "sequence":
      return `seq(${expression.items.map(renderTreeSitterExpression).join(", ")})`;
    case "choice":
      return `choice(${expression.options.map(renderTreeSitterExpression).join(", ")})`;
    case "optional":
      return `optional(${renderTreeSitterExpression(expression.expression)})`;
    case "repeat":
      return `repeat(${renderTreeSitterExpression(expression.expression)})`;
    case "repeat1":
      return `repeat1(${renderTreeSitterExpression(expression.expression)})`;
    case "separated": {
      const value = renderTreeSitterExpression(expression.item);
      const separator = renderTreeSitterExpression(expression.separator);
      return `seq(${value}, repeat(seq(${separator}, ${value})))`;
    }
    case "constructor":
    case "expressionIsland":
      throw new Error(
        `Tree-sitter generation does not support Baba expression kind ${expression.kind}`,
      );
  }
}

function renderTreeSitterTerminalPattern(pattern: GrammarTerminalPattern): string {
  switch (pattern.kind) {
    case "regex":
      return `new RegExp(${JSON.stringify(pattern.pattern)})`;
    case "literal":
      return JSON.stringify(pattern.value);
  }
}

async function run(command: string, args: string[]): Promise<void> {
  const output = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();

  if (stdout.length > 0) console.log(stdout);
  if (stderr.length > 0) console.error(stderr);
  if (!output.success) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${output.code}`);
  }
}

function libraryExtension(): string {
  if (Deno.build.os === "windows") return "dll";
  if (Deno.build.os === "darwin") return "dylib";
  return "so";
}
