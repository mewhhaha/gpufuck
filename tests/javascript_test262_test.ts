import { deepStrictEqual, equal, match, throws } from "node:assert/strict";

import {
  classifyTest262CoreTest,
  parseTest262Metadata,
  test262ExecutionModes,
  test262FrontendProbeSource,
} from "../examples/javascript-aot/src/test262.ts";
import {
  lowerTest262NegativeTest,
  lowerTest262PositiveTest,
} from "../examples/javascript-aot/src/test262_harness.ts";
import { probeApplicableTest262Source } from "../examples/javascript-aot/src/test262_scan.ts";

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

Deno.test("matches Test262 negative tests only at their declared phase and type", () => {
  const parseSource = `/*---
flags: [noStrict]
negative:
  phase: parse
  type: SyntaxError
---*/
const = 1;
`;
  const parseMetadata = parseTest262Metadata("test/language/parse-negative.js", parseSource);
  deepStrictEqual(
    lowerTest262NegativeTest(
      "test/language/parse-negative.js",
      parseSource,
      parseMetadata,
      "entry",
      "non-strict",
    ),
    { kind: "matched", phase: "parse" },
  );

  const resolutionSource = `/*---
flags: [noStrict]
negative:
  phase: resolution
  type: ReferenceError
---*/
missingBinding;
`;
  const resolutionMetadata = parseTest262Metadata(
    "test/language/resolution-negative.js",
    resolutionSource,
  );
  deepStrictEqual(
    lowerTest262NegativeTest(
      "test/language/resolution-negative.js",
      resolutionSource,
      resolutionMetadata,
      "entry",
      "non-strict",
    ),
    { kind: "matched", phase: "resolution" },
  );
});

Deno.test("keeps runtime-negative Test262 tests executable for typed validation", () => {
  const source = `/*---
flags: [noStrict]
negative:
  phase: runtime
  type: TypeError
---*/
throw new TypeError();
`;
  const metadata = parseTest262Metadata("test/language/runtime-negative.js", source);
  const result = lowerTest262NegativeTest(
    "test/language/runtime-negative.js",
    source,
    metadata,
    "entry",
    "non-strict",
  );

  equal(result.kind, "runtime-ready");
  if (result.kind === "runtime-ready") {
    equal(result.expectedType, "TypeError");
    equal(result.validation, "returned-boolean");
  }
});

Deno.test("routes temporal-dead-zone negatives through runtime faults", () => {
  const path = "test/language/runtime-tdz.js";
  const source = `/*---
flags: [noStrict]
negative:
  phase: runtime
  type: ReferenceError
---*/
value;
let value;
`;
  const metadata = parseTest262Metadata(path, source);
  const result = lowerTest262NegativeTest(
    path,
    source,
    metadata,
    "entry",
    "non-strict",
  );

  equal(result.kind, "runtime-ready");
  if (result.kind === "runtime-ready") {
    equal(result.expectedType, "ReferenceError");
    equal(result.validation, "runtime-fault");
  }
});

Deno.test("reports a Test262 negative failure that occurs in the wrong phase", () => {
  const source = `/*---
flags: [noStrict]
negative:
  phase: runtime
  type: TypeError
---*/
const = 1;
`;
  const metadata = parseTest262Metadata("test/language/wrong-phase.js", source);
  const result = lowerTest262NegativeTest(
    "test/language/wrong-phase.js",
    source,
    metadata,
    "entry",
    "non-strict",
  );

  equal(result.kind, "mismatch");
  if (result.kind === "mismatch") {
    match(result.diagnostic.message, /expected runtime TypeError, but reached parse SyntaxError/);
  }
});

Deno.test("probes Test262 negative modes with their exact expected phase", () => {
  const path = "test/language/negative.js";
  const source = `/*---
flags: [onlyStrict]
negative:
  phase: parse
  type: SyntaxError
---*/
const = 1;
`;
  const probe = probeApplicableTest262Source(
    `/checkout/${path}`,
    path,
    source,
    "entry",
  );

  deepStrictEqual(probe.outcomes, [{
    kind: "negative-ready",
    mode: "strict",
    phase: "parse",
    expectedType: "SyntaxError",
  }]);
});

Deno.test("rejects restricted assignments during strict-mode parsing", () => {
  const path = "test/language/strict-arguments-assignment.js";
  const source = `/*---
flags: [onlyStrict]
negative:
  phase: parse
  type: SyntaxError
---*/
$DONOTEVALUATE();
function fail() {
  arguments = 7;
}
`;
  const probe = probeApplicableTest262Source(
    `/checkout/${path}`,
    path,
    source,
    "entry",
  );

  deepStrictEqual(probe.outcomes, [{
    kind: "negative-ready",
    mode: "strict",
    phase: "parse",
    expectedType: "SyntaxError",
  }]);
});

Deno.test("keeps unresolved name reads in the runtime ReferenceError phase", () => {
  const path = "test/language/runtime-reference-error.js";
  const source = `/*---
flags: [noStrict]
negative:
  phase: runtime
  type: ReferenceError
---*/
missingBinding;
`;
  const probe = probeApplicableTest262Source(
    `/checkout/${path}`,
    path,
    source,
    "entry",
  );

  deepStrictEqual(probe.outcomes, [{
    kind: "negative-ready",
    mode: "non-strict",
    phase: "runtime",
    expectedType: "ReferenceError",
  }]);
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

Deno.test("probes every required mode of a positive Test262 source", () => {
  const path = "test/language/example.js";
  const probe = probeApplicableTest262Source(
    `/checkout/${path}`,
    path,
    `/*---
flags: []
---*/
const answer = 42;
`,
    "testEntry",
  );

  deepStrictEqual(probe.executionModes, ["non-strict", "strict"]);
  deepStrictEqual(probe.outcomes, [
    { kind: "ready", mode: "non-strict" },
    { kind: "ready", mode: "strict" },
  ]);
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

Deno.test("transforms Test262 assertions inside class methods", () => {
  const source = `/*---
flags: [noStrict]
---*/
class Counter {
  verify() {
    assert.sameValue(arguments.length, 2);
  }
}
Counter.prototype.verify(40, 2);
`;
  const metadata = parseTest262Metadata("test/language/class-method.js", source);
  const result = lowerTest262PositiveTest(
    "test/language/class-method.js",
    source,
    metadata,
    "testEntry",
    "non-strict",
  );

  equal(result.ok, true, result.ok ? undefined : result.diagnostics[0].message);
});

Deno.test("prepares function expressions nested in Test262 parameter defaults", () => {
  const path = "test/language/default-parameter-function.js";
  const source = `/*---
flags: [noStrict]
features: [default-parameters]
---*/
var read = function(value = (function() { return 42; }())) {
  return value;
};
assert.sameValue(read(), 42);
`;
  const metadata = parseTest262Metadata(path, source);
  const result = lowerTest262PositiveTest(
    path,
    source,
    metadata,
    "testEntry",
    "non-strict",
  );

  equal(result.ok, true, result.ok ? undefined : result.diagnostics[0].message);
});

Deno.test("routes dynamic Test262 SameValue assertions through the runtime model", () => {
  const source = `/*---
flags: [noStrict]
---*/
const object = {};
const alias = object;
assert.sameValue(alias, object);
`;
  const metadata = parseTest262Metadata("test/language/runtime-same-value.js", source);
  const result = lowerTest262PositiveTest(
    "test/language/runtime-same-value.js",
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
