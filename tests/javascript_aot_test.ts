import { equal, match, ok, throws } from "node:assert/strict";

import { lowerJavaScriptAotSource } from "../examples/javascript-aot/mod.ts";
import { parseJavaScriptAotModule } from "../examples/javascript-aot/src/parser.ts";
import { lowerJavaScriptRuntimeModule } from "../examples/javascript-aot/src/runtime_lowering.ts";

Deno.test("rejects unimplemented intrinsic wrapper construction during lowering", () => {
  const result = lowerJavaScriptAotSource(
    "runtime-boolean-wrapper.mjs",
    `export function main() {
  const source = {};
  source.value = true;
  try {
    return new Boolean(source.value);
  } catch (error) {
    return error;
  }
}`,
  );

  equal(result.ok, false);
  if (result.ok) return;
  equal(result.diagnostics[0].stage, "lower");
  match(
    result.diagnostics[0].message,
    /runtime-model new Boolean requires intrinsic primitive-wrapper support/,
  );
});

Deno.test("does not treat intrinsic wrappers as unresolved runtime globals", () => {
  const module = parseJavaScriptAotModule(
    "unresolved-boolean-wrapper.mjs",
    `export function main() { return new Boolean(true); }`,
  );

  throws(
    () =>
      lowerJavaScriptRuntimeModule(module, "main", {
        allowUnresolvedReferences: true,
      }),
    /runtime-model new Boolean requires intrinsic primitive-wrapper support/,
  );
});

Deno.test("applies strict parameter rules to class methods", () => {
  const result = lowerJavaScriptAotSource(
    "strict-class-method.mjs",
    `class Invalid { method(value, value) { return value; } }
export function main() { return 42; }`,
  );

  equal(result.ok, false);
  if (result.ok) return;
  match(
    result.diagnostics[0].message,
    /strict mode function declares parameter "value" more than once/,
  );
});

Deno.test("rejects duplicate names in non-simple parameter lists", () => {
  const result = lowerJavaScriptAotSource(
    "duplicate-default-parameter.mjs",
    `function invalid(value, value = 0) { return value; }
export function main() { return 42; }`,
  );

  equal(result.ok, false);
  if (result.ok) return;
  equal(result.diagnostics[0].stage, "parse");
  match(
    result.diagnostics[0].message,
    /non-simple parameter function declares parameter "value" more than once/,
  );
});

Deno.test("rejects duplicate bound names hidden by parameter destructuring", () => {
  const result = lowerJavaScriptAotSource(
    "duplicate-bound-parameter.mjs",
    `function invalid({ value }, value = 0) { return value; }
export function main() { return 42; }`,
  );

  equal(result.ok, false);
  if (result.ok) return;
  equal(result.diagnostics[0].stage, "parse");
  match(
    result.diagnostics[0].message,
    /non-simple parameter function declares parameter "value" more than once/,
  );
});

Deno.test("rejects use strict directives with non-simple parameter lists", () => {
  const result = lowerJavaScriptAotSource(
    "strict-default-parameter.mjs",
    `function invalid(value = 0) { "use strict"; return value; }
export function main() { return 42; }`,
  );

  equal(result.ok, false);
  if (result.ok) return;
  equal(result.diagnostics[0].stage, "parse");
  match(
    result.diagnostics[0].message,
    /non-simple parameter list cannot contain a "use strict" directive/,
  );
});

Deno.test("keeps a named JavaScript function expression name out of its outer scope", () => {
  const frontend = lowerJavaScriptAotSource(
    "named-function-scope.mjs",
    `export function main() { const local = function privateName(value) { return value; }; return privateName(42); }`,
  );
  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /name "privateName" is not lexically declared/);
});

Deno.test("rejects a missing JavaScript semicolon without an ASI boundary", () => {
  const frontend = lowerJavaScriptAotSource(
    "missing-semicolon.mjs",
    "export function main() { const answer = 42 return answer; }",
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /Unexpected token \"return\"/);
});

Deno.test("bounds repeated JavaScript automatic semicolon insertion", () => {
  const declarations = Array.from(
    { length: 5 },
    (_, index) => `let value${index} = ${index}`,
  ).join("\n");
  const frontend = lowerJavaScriptAotSource(
    "automatic-semicolon-limit.mjs",
    `export function main() {\n${declarations}\nreturn 0;\n}`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(
    frontend.diagnostics[0].message,
    /requires more than 4 automatic semicolon insertions/,
  );
});

Deno.test("bounds JavaScript token streams before generated-parser work explodes", () => {
  const declarations = Array.from(
    { length: 1_700 },
    (_, index) => `let value${index} = ${index};`,
  ).join("");
  const frontend = lowerJavaScriptAotSource(
    "token-limit.mjs",
    `export function main() { ${declarations} return 0; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /exceeds the 8192-token parser limit/);
});

Deno.test("JavaScript token limits do not reject a large literal", () => {
  const literal = "x".repeat(20_000);
  const module = parseJavaScriptAotModule(
    "large-literal.mjs",
    `export function main() { return "${literal}"; }`,
  );

  equal(module.declarations.length, 1);
});

Deno.test("bounds JavaScript source bytes before allocating parser state", () => {
  const frontend = lowerJavaScriptAotSource(
    "source-limit.mjs",
    `/*${"x".repeat(256 * 1024)}*/`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /exceeds the 262144-byte source limit/);
});

Deno.test("JavaScript source bytes are accepted at the parser boundary", () => {
  const prefix = 'export function main() { return "';
  const suffix = '"; }';
  const source = `${prefix}${"x".repeat(256 * 1024 - prefix.length - suffix.length)}${suffix}`;
  const module = parseJavaScriptAotModule("source-boundary.mjs", source);

  equal(module.declarations.length, 1);
});

Deno.test("bounds JavaScript delimiter nesting before parser recursion overflows", () => {
  const frontend = lowerJavaScriptAotSource(
    "delimiter-depth.mjs",
    `export function main() { return ${"(".repeat(512)}0${")".repeat(512)}; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /exceeds the syntax nesting limit of 256/);
});

Deno.test("bounds JavaScript prefix operators before parser recursion overflows", () => {
  const frontend = lowerJavaScriptAotSource(
    "prefix-depth.mjs",
    `export function main() { return ${"!".repeat(2_048)}true; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /exceeds the prefix-operator nesting limit of 256/);
});

Deno.test("rejects malformed JavaScript numeric separators during parsing", () => {
  const frontend = lowerJavaScriptAotSource(
    "numeric-separator.mjs",
    `export function main() { return 1__0; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "J1001");
});

Deno.test("rejects dynamic JavaScript code generation before GPU compilation", () => {
  const frontend = lowerJavaScriptAotSource(
    "dynamic-code.mjs",
    `export function main() { return eval("40 + 2"); }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "J1002");
  match(frontend.diagnostics[0].message, /forbids dynamic code generation through "eval"/);

  const constructor = lowerJavaScriptAotSource(
    "function-constructor.mjs",
    `export function main() { return new Function("return 42"); }`,
  );
  equal(constructor.ok, false);
  if (constructor.ok) return;
  match(constructor.diagnostics[0].message, /forbids dynamic code generation through new Function/);
});

Deno.test("rejects top-level constants that read a later lexical binding", () => {
  const frontend = lowerJavaScriptAotSource(
    "temporal-dead-zone.mjs",
    `export const main = answer; const answer = 42;`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /name "answer" is not lexically declared/);
});

Deno.test("reports direct JavaScript calls that omit required arguments", () => {
  const frontend = lowerJavaScriptAotSource(
    "arity.mjs",
    `function add(left, right) { return left + right; } export function main() { return add(42); }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /function "add" expects 2 arguments.*supplies 1/);
});

Deno.test("rejects assignment to a JavaScript const binding", () => {
  const frontend = lowerJavaScriptAotSource(
    "const-assignment.mjs",
    `export function main() { const answer = 40; answer += 2; return answer; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /cannot replace immutable binding "answer"/);
});

Deno.test("reports unsupported JavaScript array callback arity before inference", () => {
  const frontend = lowerJavaScriptAotSource(
    "map-index.mjs",
    `export function main() { return [40].map(function(value, index) { return value + index; })[0]; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /Array\.map callback expects 1 parameter.*declares 2/);
});

Deno.test("rejects mutable closure cells until their state model is explicit", () => {
  const frontend = lowerJavaScriptAotSource(
    "captured-mutation.mjs",
    `export function main() { let value = 40; const add = function(offset) { value += offset; return value; }; return add(2); }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /closure assignment to captured binding "value"/);
});

Deno.test("rejects snapshot lowering when a closure reads a later-mutated binding", () => {
  const frontend = lowerJavaScriptAotSource(
    "mutable-capture.mjs",
    `export function main() { let value = 40; const read = function(unit) { return value; }; value += 2; return read(0); }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /closure reads captured mutable binding "value"/);
});

Deno.test("rejects runtime-model finally before expanding callable dispatch", () => {
  const frontend = lowerJavaScriptAotSource(
    "runtime-finally.mjs",
    `export function main() {
  const state = {};
  state.answer = 0;
  const read = function() {
    try {
      return 0;
    } finally {
      return 42;
    }
  };
  return state.answer === 0 ? read() : 0;
}`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(
    frontend.diagnostics[0].message,
    /runtime-model finally completion replacement is not yet supported/,
  );
});

Deno.test("runtime-model lowering accepts programs beyond its former syntax budget", () => {
  const frontend = lowerJavaScriptAotSource(
    "runtime-syntax-scale.mjs",
    `export function main() { const object = {}; ${"0;".repeat(80)} return 42; }`,
  );

  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
});

Deno.test("runtime-model lowering joins sequential conditional expressions", () => {
  const frontend = lowerJavaScriptAotSource(
    "runtime-branch-scale.mjs",
    `export function main() { const object = {}; let flag = true; ${
      "flag = flag ? true : false; flag = flag && true;".repeat(16)
    } ${"try { 0; } catch { 0; }".repeat(16)} return 42; }`,
  );

  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
});

Deno.test("AOT lowering accepts try continuations at its recursion boundary", () => {
  const frontend = lowerJavaScriptAotSource(
    "try-continuation-boundary.mjs",
    `export function main() { let value = 0; ${
      "try { value += 1; } finally { value += 0; }".repeat(128)
    } return value; }`,
  );

  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
});

Deno.test("AOT lowering bounds sequential try continuation recursion", () => {
  const frontend = lowerJavaScriptAotSource(
    "try-continuation-limit.mjs",
    `export function main() { let value = 0; ${
      "try { value += 1; } finally { value += 0; }".repeat(129)
    } return value; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /try continuation nesting exceeds the limit of 128/);
});

Deno.test("flat JavaScript declarations stop at the surface depth boundary", () => {
  const declarations = Array.from(
    { length: 1_050 },
    (_, index) => `let value${index} = 0;`,
  ).join("");
  const frontend = lowerJavaScriptAotSource(
    "declaration-depth.mjs",
    `export function main() { ${declarations} return 0; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /functional surface expression exceeds depth 1024/);
});
