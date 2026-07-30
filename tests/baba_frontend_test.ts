import { deepStrictEqual, equal } from "node:assert/strict";

import { BabaUtf8ByteOffsets } from "../src/baba_frontend.ts";

Deno.test("ASCII Baba spans keep their UTF-16 offsets", () => {
  const offsets = new BabaUtf8ByteOffsets("hello");

  equal(offsets.byteLength, 5);
  deepStrictEqual(offsets.span({ start: 1, end: 4 }), {
    startByte: 1,
    endByte: 4,
  });
});

Deno.test("Baba spans map Unicode and surrogate pairs to UTF-8 bytes", () => {
  const offsets = new BabaUtf8ByteOffsets("aé😀z");

  equal(offsets.byteLength, 8);
  deepStrictEqual(offsets.span({ start: 1, end: 4 }), {
    startByte: 1,
    endByte: 7,
  });
});
