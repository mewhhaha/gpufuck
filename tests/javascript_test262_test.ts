import { deepStrictEqual, equal, match, throws } from "node:assert/strict";

import {
  classifyTest262CoreTest,
  parseTest262Metadata,
  test262ExecutionModes,
  test262FrontendProbeSource,
} from "../examples/javascript-aot/src/test262.ts";
import { lowerTest262PositiveTest } from "../examples/javascript-aot/src/test262_harness.ts";

Deno.test("reads Test262 inline lists and negative expectations", () => {
  const metadata = parseTest262Metadata(
    "test/language/example.js",
    `/*---
flags: [onlyStrict, module]
features: [BigInt, "class-fields-public"]
includes: [assert.js]
negative:
  phase: runtime
  type: TypeError
---*/`,
  );

  deepStrictEqual(metadata, {
    flags: ["onlyStrict", "module"],
    features: ["BigInt", "class-fields-public"],
    includes: ["assert.js"],
    negative: { phase: "runtime", type: "TypeError" },
  });
});

Deno.test("reads Test262 block lists without consuming the next field", () => {
  const metadata = parseTest262Metadata(
    "test/language/example.js",
    `/*---
features:
  - Symbol
  - arrow-function
flags:
  - noStrict
description: ignored
---*/`,
  );

  deepStrictEqual(metadata.features, ["Symbol", "arrow-function"]);
  deepStrictEqual(metadata.flags, ["noStrict"]);
  deepStrictEqual(metadata.includes, []);
  equal(metadata.negative, null);
});

Deno.test("reports malformed Test262 negative metadata with its path", () => {
  throws(
    () =>
      parseTest262Metadata(
        "test/language/broken.js",
        `/*---
negative:
  phase: compile
  type: SyntaxError
---*/`,
      ),
    /Test262 file "test\/language\/broken\.js" has unsupported negative phase "compile"/,
  );
});

Deno.test("excludes only fixtures and dynamic code from the core Test262 profile", () => {
  deepStrictEqual(
    classifyTest262CoreTest("test/language/eval-code/direct/strict.js"),
    { kind: "excluded", reason: "dynamic-code-generation" },
  );
  deepStrictEqual(
    classifyTest262CoreTest("test/language/module-code/example_FIXTURE.js"),
    { kind: "fixture" },
  );
  deepStrictEqual(
    classifyTest262CoreTest("test/language/statements/if/basic.js"),
    { kind: "applicable" },
  );
});

Deno.test("adapts positive Test262 scripts without claiming negative tests", () => {
  const metadata = parseTest262Metadata(
    "test/language/example.js",
    `/*---
flags: [noStrict]
---*/`,
  );
  const probe = test262FrontendProbeSource(
    "/*---\nflags: [noStrict]\n---*/\nconst answer = 42;",
    metadata,
    "entry",
    "non-strict",
  );

  match(probe ?? "", /^export function entry\(\) \{/);
  match(probe ?? "", /const answer = 42;/);

  const negative = parseTest262Metadata(
    "test/language/negative.js",
    `/*---
negative:
  phase: parse
  type: SyntaxError
---*/`,
  );
  equal(test262FrontendProbeSource("", negative, "entry", "non-strict"), null);
});

Deno.test("expands Test262 files into the strictness modes required by their flags", () => {
  const metadata = (flags: string) =>
    parseTest262Metadata("test/language/example.js", `/*---\nflags: ${flags}\n---*/`);

  deepStrictEqual(test262ExecutionModes(metadata("[]")), ["non-strict", "strict"]);
  deepStrictEqual(test262ExecutionModes(metadata("[noStrict]")), ["non-strict"]);
  deepStrictEqual(test262ExecutionModes(metadata("[onlyStrict]")), ["strict"]);
  deepStrictEqual(test262ExecutionModes(metadata("[module]")), ["module"]);
  deepStrictEqual(test262ExecutionModes(metadata("[raw]")), ["raw"]);
});

Deno.test("injects strict mode only into the strict Test262 script variant", () => {
  const metadata = parseTest262Metadata(
    "test/language/example.js",
    `/*---
flags: []
---*/`,
  );
  const source = "/*---\nflags: []\n---*/\nassert(true);";
  const nonStrict = test262FrontendProbeSource(source, metadata, "entry", "non-strict");
  const strict = test262FrontendProbeSource(source, metadata, "entry", "strict");

  match(nonStrict ?? "", /^export function entry\(\) \{\n\nassert/);
  match(strict ?? "", /^export function entry\(\) \{\n"use strict";\n\nassert/);
});

Deno.test("lowers Test262 assertions to checked Functional Core expressions", () => {
  const source = `/*---
flags: [noStrict]
---*/
assert.sameValue(40 + 2, 42);
assert.notSameValue(41, 42);
assert(true);
`;
  const metadata = parseTest262Metadata("test/language/assertions.js", source);
  const result = lowerTest262PositiveTest(
    "test/language/assertions.js",
    source,
    metadata,
    "testEntry",
    "non-strict",
  );

  equal(result.ok, true, result.ok ? undefined : result.diagnostics[0].message);
});

Deno.test("routes Test262 property mutation assertions through the runtime model", () => {
  const source = `/*---
flags: [noStrict]
---*/
const point = { answer: 40 };
point.answer = 42;
assert.sameValue(point.answer, 42);
`;
  const metadata = parseTest262Metadata("test/language/runtime-object.js", source);
  const result = lowerTest262PositiveTest(
    "test/language/runtime-object.js",
    source,
    metadata,
    "testEntry",
    "non-strict",
  );

  equal(result.ok, true, result.ok ? undefined : result.diagnostics[0].message);
});

Deno.test("lowers explicit Test262 error throws through lexical catch semantics", () => {
  const source = `/*---
flags: [noStrict]
---*/
assert.throws(TypeError, function() {
  throw new TypeError("expected");
});
`;
  const metadata = parseTest262Metadata("test/language/throws.js", source);
  const result = lowerTest262PositiveTest(
    "test/language/throws.js",
    source,
    metadata,
    "testEntry",
    "non-strict",
  );

  equal(result.ok, true, result.ok ? undefined : result.diagnostics[0].message);
});

Deno.test("lowers Test262 throwing calls through cross-call completion", () => {
  const source = `/*---
flags: [noStrict]
---*/
function fail() {
  throw new TypeError();
}
assert.throws(TypeError, function() {
  fail();
});
`;
  const metadata = parseTest262Metadata("test/language/cross-call-throws.js", source);
  const result = lowerTest262PositiveTest(
    "test/language/cross-call-throws.js",
    source,
    metadata,
    "testEntry",
    "non-strict",
  );

  equal(result.ok, true, result.ok ? undefined : result.diagnostics[0].message);
});
