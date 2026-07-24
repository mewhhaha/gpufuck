import { deepStrictEqual, equal, match, ok } from "node:assert/strict";

import { lowerGleamFunctionalSource, lowerGleamFunctionalSources } from "../gleam_functional.ts";

Deno.test("keeps opaque Gleam constructors private across modules", () => {
  const frontend = lowerGleamFunctionalSources([
    {
      name: "secret/library",
      source: `pub opaque type Secret { Secret(Int) }\n`,
    },
    {
      name: "secret/main",
      source: `import secret/library.{Secret}\npub fn main() -> Int { 42 }\n`,
    },
  ], { module: "secret/main", exportName: "main" });

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /missing public value or constructor/);
});

Deno.test("rejects unsupported Gleam bit-array segment encodings", () => {
  const frontend = lowerGleamFunctionalSource(
    "bit_arrays",
    `pub fn main() { <<"duck":utf16>> }\n`,
  );

  ok(!frontend.ok);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /supports only|must use the utf8 encoding/);
});

Deno.test("rejects negative static Gleam bit-array segment sizes", () => {
  const frontend = lowerGleamFunctionalSource(
    "bit_arrays",
    `pub fn main() { <<1:-1>> }\n`,
  );

  ok(!frontend.ok);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /cannot have negative size -1/);
});

Deno.test("rejects cyclic Gleam type aliases with their expansion path", () => {
  const frontend = lowerGleamFunctionalSource(
    "alias_cycle",
    `
type First = Second
type Second = First

pub fn main() -> Int {
  42
}
`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /First -> Second -> First/);
});

Deno.test("maps Baba lexical failures to Gleam UTF-8 byte spans", () => {
  const source = `// λ\npub fn main() -> Int { @ }\n`;
  const frontend = lowerGleamFunctionalSource("invalid", source);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "G1001");
  const invalidByte = new TextEncoder().encode(source.slice(0, source.indexOf("@"))).byteLength;
  deepStrictEqual(frontend.diagnostics[0].span, {
    startByte: invalidByte,
    endByte: invalidByte + 1,
  });
  match(frontend.diagnostics[0].message, /PARSE_LEXICAL_ERROR/);
});

Deno.test("reports a missing imported Gleam function with its module name", () => {
  const frontend = lowerGleamFunctionalSources([
    { name: "library", source: `pub fn present(value: Int) -> Int { value }\n` },
    {
      name: "application",
      source: `import library.{missing}\npub fn main() -> Int { missing(42) }\n`,
    },
  ], { module: "application", exportName: "main" });

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].module, "application");
  match(frontend.diagnostics[0].message, /"library.missing"/);
});

Deno.test("rejects a constructor arm after a Gleam catch-all", () => {
  const frontend = lowerGleamFunctionalSource(
    "case_order",
    `
pub type Choice {
  First
  Second
}

pub fn main() -> Int {
  case First {
    _ -> 1
    Second -> 2
  }
}
`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /catch-all case arm must be last/);
});
