import { deepStrictEqual, equal, match, throws } from "node:assert/strict";

import type { GpuFunctionalCompiler } from "../functional.ts";
import {
  executeTest262Case,
  type Test262ExecutionCase,
} from "../examples/javascript-aot/src/test262_execute.ts";
import {
  encodeTest262WorkerMessage,
  parseTest262WorkerRequest,
  parseTest262WorkerResponse,
  readNdjsonLines,
} from "../examples/javascript-aot/src/test262_worker_protocol.ts";

Deno.test("streams one NDJSON message across arbitrary chunk boundaries", async () => {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('{"type":"ready"}\n{"type":'));
      controller.enqueue(encoder.encode('"close"}'));
      controller.close();
    },
  });

  const lines: string[] = [];
  for await (const line of readNdjsonLines(readable)) lines.push(line);

  deepStrictEqual(lines, ['{"type":"ready"}', '{"type":"close"}']);
});

Deno.test("round-trips Test262 worker execute and result messages", () => {
  const executionCase: Test262ExecutionCase = {
    absolutePath: "/checkout/test/language/example.js",
    path: "test/language/example.js",
    mode: "strict",
    metadata: {
      flags: ["onlyStrict"],
      features: [],
      includes: [],
      negative: null,
    },
    expectedRuntimeErrorType: null,
  };
  const executeLine = new TextDecoder().decode(encodeTest262WorkerMessage({
    type: "execute",
    requestId: 7,
    request: { executionCase, entryName: "testEntry" },
  })).trimEnd();
  const resultLine = new TextDecoder().decode(encodeTest262WorkerMessage({
    type: "result",
    requestId: 7,
    response: {
      ok: true,
      result: { kind: "passed", expectation: "positive" },
    },
  })).trimEnd();

  deepStrictEqual(parseTest262WorkerRequest(executeLine), {
    type: "execute",
    requestId: 7,
    request: { executionCase, entryName: "testEntry" },
  });
  deepStrictEqual(parseTest262WorkerResponse(resultLine), {
    type: "result",
    requestId: 7,
    response: {
      ok: true,
      result: { kind: "passed", expectation: "positive" },
    },
  });
});

Deno.test("rejects malformed Test262 worker protocol messages at the process boundary", () => {
  throws(
    () =>
      parseTest262WorkerResponse(
        '{"type":"result","requestId":3,"response":{"ok":true,' +
          '"result":{"kind":"passed"}}}',
      ),
    /Invalid Test262 execution worker response/,
  );
});

Deno.test("reports compiler fuel exhaustion as a resource limit", async () => {
  let maximumSteps: number | undefined;
  let maximumStepsPerDispatch: number | undefined;
  const compiler = {
    compileModule(
      _module: unknown,
      options: { readonly maximumSteps?: number; readonly maximumStepsPerDispatch?: number },
    ) {
      maximumSteps = options.maximumSteps;
      maximumStepsPerDispatch = options.maximumStepsPerDispatch;
      return Promise.resolve({
        ok: false,
        diagnostics: [{
          code: "F1003",
          message: "semantic compilation exhausted its step limit",
        }],
      });
    },
  } as unknown as GpuFunctionalCompiler;

  const result = await executeTest262Case(compiler, {
    executionCase: {
      absolutePath: "tests/fixtures/javascript_test262_resource_limit.js",
      path: "test/language/resource-limit.js",
      mode: "non-strict",
      metadata: {
        flags: ["noStrict"],
        features: [],
        includes: [],
        negative: null,
      },
      expectedRuntimeErrorType: null,
    },
    entryName: "testEntry",
  });

  equal(result.kind, "resource-limited");
  if (result.kind === "resource-limited") {
    match(result.reason, /F1003/);
  }
  equal(maximumSteps, 10_000_000);
  equal(maximumStepsPerDispatch, 16_384);
});
