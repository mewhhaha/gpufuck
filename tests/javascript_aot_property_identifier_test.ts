import { deepStrictEqual, equal, match, ok } from "node:assert/strict";

import { lowerJavaScriptAotSource } from "../examples/javascript-aot/mod.ts";
import { parseJavaScriptAotModule } from "../examples/javascript-aot/src/parser.ts";

Deno.test("decodes ASCII Unicode escapes in property IdentifierNames", () => {
  const module = parseJavaScriptAotModule(
    "escaped-property-identifiers.mjs",
    `class Counter {
  constr\\u0075ctor(value) {
    this.value = value;
  }

  r\\u0065ad2() {
    return this.value;
  }
}

export const main = ({
  \\u0061nswer: 42,
  m\\u0065thod() { return 0; }
}).a\\u006eswer;
`,
  );

  const classDeclaration = module.declarations[0];
  ok(classDeclaration?.kind === "function");
  deepStrictEqual(classDeclaration.parameters, ["value"]);
  deepStrictEqual(classDeclaration.classMethods?.map((method) => method.name), ["read2"]);

  const mainDeclaration = module.declarations[1];
  ok(mainDeclaration?.kind === "constant");
  const propertyAccess = mainDeclaration.value;
  ok(propertyAccess.kind === "property");
  equal(propertyAccess.name, "answer");
  ok(propertyAccess.value.kind === "object");
  deepStrictEqual(
    propertyAccess.value.properties.map((property) => property.name),
    ["answer", "method"],
  );
});

Deno.test("rejects a property escape that decodes outside ASCII IdentifierStart", () => {
  const result = lowerJavaScriptAotSource(
    "invalid-property-start.mjs",
    `export const main = ({ \\u0030answer: 42 });`,
  );

  equal(result.ok, false);
  if (result.ok) return;
  equal(result.diagnostics[0].stage, "parse");
  match(result.diagnostics[0].message, /"\\\\u0030answer".*ASCII IdentifierStart/);
});

Deno.test("rejects a property escape that decodes outside ASCII IdentifierPart", () => {
  const result = lowerJavaScriptAotSource(
    "invalid-property-part.mjs",
    `export const main = ({ answer: 42 }).ans\\u002der;`,
  );

  equal(result.ok, false);
  if (result.ok) return;
  equal(result.diagnostics[0].stage, "parse");
  match(result.diagnostics[0].message, /"ans\\\\u002der".*ASCII IdentifierPart/);
});

Deno.test("keeps Unicode escapes out of binding identifiers", () => {
  const result = lowerJavaScriptAotSource(
    "escaped-binding.mjs",
    `export function main() { const \\u0061nswer = 42; return 0; }`,
  );

  equal(result.ok, false);
  if (result.ok) return;
  equal(result.diagnostics[0].stage, "parse");
});

Deno.test("keeps Unicode escapes out of reference identifiers", () => {
  const result = lowerJavaScriptAotSource(
    "escaped-reference.mjs",
    `export function main() { return \\u0061nswer; }`,
  );

  equal(result.ok, false);
  if (result.ok) return;
  equal(result.diagnostics[0].stage, "parse");
});
