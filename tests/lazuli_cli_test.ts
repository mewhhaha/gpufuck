import { deepStrictEqual, equal, ok } from "node:assert/strict";

import { main } from "../lazuli_cli.ts";

interface BatchRecord {
  readonly path: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly fault?: {
    readonly code: string;
  };
  readonly stats: unknown;
}

function captureOutput(): {
  readonly errors: string[];
  readonly logs: string[];
  readonly output: Pick<Console, "error" | "log">;
} {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    logs,
    output: {
      error(...values: unknown[]) {
        errors.push(values.map(String).join(" "));
      },
      log(...values: unknown[]) {
        logs.push(values.map(String).join(" "));
      },
    },
  };
}

Deno.test("runs Lazuli batch results in source-path order", async () => {
  const captured = captureOutput();
  const sourcePaths = [
    "examples/lazuli/list.laz",
    "examples/lazuli/answer.laz",
    "examples/lazuli/proofs.laz",
  ];

  const exitCode = await main(["run-batch", ...sourcePaths], captured.output);

  equal(exitCode, 0);
  deepStrictEqual(captured.errors, []);
  equal(captured.logs.length, 1);
  const records = JSON.parse(captured.logs[0] ?? "") as BatchRecord[];
  deepStrictEqual(
    records.map(({ path, ok: successful, value }) => ({ path, successful, value })),
    [
      {
        path: sourcePaths[0],
        successful: true,
        value: { kind: "integer", value: 42 },
      },
      {
        path: sourcePaths[1],
        successful: true,
        value: { kind: "integer", value: 42 },
      },
      {
        path: sourcePaths[2],
        successful: true,
        value: { kind: "integer", value: 42 },
      },
    ],
  );
  for (const record of records) ok(record.stats);
});

Deno.test("returns a nonzero exit code for a faulted Lazuli batch lane", async () => {
  const captured = captureOutput();
  const sourcePaths = [
    "examples/lazuli/answer.laz",
    "tests/fixtures/lazuli/divide-by-zero.laz",
  ];

  const exitCode = await main(["run-batch", ...sourcePaths], captured.output);

  equal(exitCode, 1);
  deepStrictEqual(captured.errors, []);
  equal(captured.logs.length, 1);
  const records = JSON.parse(captured.logs[0] ?? "") as BatchRecord[];
  deepStrictEqual(
    records.map(({ path, ok: successful, value, fault }) => ({
      path,
      successful,
      value,
      faultCode: fault?.code,
    })),
    [
      {
        path: sourcePaths[0],
        successful: true,
        value: { kind: "integer", value: 42 },
        faultCode: undefined,
      },
      {
        path: sourcePaths[1],
        successful: false,
        value: undefined,
        faultCode: "L3007",
      },
    ],
  );
  for (const record of records) ok(record.stats);
});

Deno.test("reports every batch compilation failure without evaluation output", async () => {
  const captured = captureOutput();
  const invalidSourcePaths = ["deno.json", "README.md"];

  const exitCode = await main(["run-batch", ...invalidSourcePaths], captured.output);

  equal(exitCode, 1);
  equal(captured.logs.length, 0);
  for (const sourcePath of invalidSourcePaths) {
    ok(
      captured.errors.some((message) =>
        message.startsWith(`${JSON.stringify(sourcePath)}: error[`)
      ),
    );
  }
});
