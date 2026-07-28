import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";

import {
  type CompactFrontendProgram,
  CpuFrontend,
  WebGpuRuntime,
} from "@mewhhaha/baba/runtime/webgpu";

import { MAXIMUM_SOURCE_BYTE_LENGTH } from "../src/semantic/abi.ts";
import { sourceTooLargeDiagnostic } from "../src/semantic/compilation_diagnostics.ts";
import { BabaGpuLazuliCompiler } from "../src/lazuli/baba_gpu_compiler.ts";
import {
  lowerLazuliGpuFrontendResult,
  parseLazuliSourceForCompilation,
} from "../src/lazuli/frontend.ts";

const planBytes = Deno.readFileSync(
  new URL("../language/lazuli/generated/wasm/parser.plan", import.meta.url),
);
const babaFrontend = CpuFrontend.create(planBytes);

const exampleUrls = Array.from(
  Deno.readDirSync(new URL("../examples/lazuli", import.meta.url)),
)
  .filter((entry) => entry.isFile && entry.name.endsWith(".laz"))
  .map((entry) => new URL(`../examples/lazuli/${entry.name}`, import.meta.url))
  .sort((left, right) => left.pathname.localeCompare(right.pathname));

Deno.test("Baba compact frontend lowers every Lazuli example to the reference surface", () => {
  for (const exampleUrl of exampleUrls) {
    const source = Deno.readTextFileSync(exampleUrl);
    const reference = parseLazuliSourceForCompilation(source);
    const babaResult = babaFrontend.ingest(source);
    ok(
      babaResult.ok,
      `${exampleUrl.pathname} was rejected by Baba: ${JSON.stringify(babaResult.diagnostics)}`,
    );

    const lowered = lowerLazuliGpuFrontendResult(source, babaResult, babaFrontend.plan);
    deepStrictEqual(lowered, reference, exampleUrl.pathname);
  }
});

Deno.test("Baba compact frontend diagnostics use the Lazuli parse boundary", () => {
  const source = "fn main = ;";
  const babaResult = babaFrontend.ingest(source);
  ok(!babaResult.ok, "invalid Lazuli source was accepted by Baba");

  deepStrictEqual(
    lowerLazuliGpuFrontendResult(source, babaResult, babaFrontend.plan),
    {
      sourceByteLength: source.length,
      frontend: {
        ok: false,
        diagnostics: babaResult.diagnostics.map((diagnostic) => ({
          stage: "parse",
          code: "F1001",
          message: `${diagnostic.code}: ${diagnostic.message}`,
          span: {
            startByte: diagnostic.start,
            endByte: diagnostic.end,
          },
        })),
      },
    },
  );
});

Deno.test("Baba compact frontend accepts GPU node allocation order", () => {
  const source = "fn main = 6 * 7;";
  const reference = parseLazuliSourceForCompilation(source);
  const babaResult = babaFrontend.ingest(source);
  ok(babaResult.ok, "valid Lazuli source was rejected by Baba");

  deepStrictEqual(
    lowerLazuliGpuFrontendResult(
      source,
      { ...babaResult, program: reverseNonrootNodes(babaResult.program) },
      babaFrontend.plan,
    ),
    reference,
  );
});

Deno.test("Baba compact frontend rejects unowned edge records", () => {
  const source = "fn main = 42;";
  const babaResult = babaFrontend.ingest(source);
  ok(babaResult.ok, "valid Lazuli source was rejected by Baba");

  throws(
    () =>
      lowerLazuliGpuFrontendResult(
        source,
        {
          ...babaResult,
          program: {
            ...babaResult.program,
            edges: new Int32Array([...babaResult.program.edges, 0, 0, 0, 0]),
          },
        },
        babaFrontend.plan,
      ),
    /edge \d+ belongs to no node/,
  );
});

Deno.test("Baba compact frontend rejects disconnected nodes", () => {
  const source = "fn main = 42;";
  const babaResult = babaFrontend.ingest(source);
  ok(babaResult.ok, "valid Lazuli source was rejected by Baba");

  const edges = new Int32Array(babaResult.program.edges);
  const nodeEdgeOffset = edges.findIndex((word, index) => index % 4 === 2 && word === 1);
  ok(nodeEdgeOffset !== -1, "Baba fixture has no node edge");
  edges[nodeEdgeOffset] = 0;
  edges[nodeEdgeOffset + 1] = 0;

  throws(
    () =>
      lowerLazuliGpuFrontendResult(
        source,
        { ...babaResult, program: { ...babaResult.program, edges } },
        babaFrontend.plan,
      ),
    /node \d+ has 0 incoming node edges/,
  );
});

Deno.test("Baba GPU compilation rejects oversized source before frontend dispatch", async () => {
  const runtime = await WebGpuRuntime.create();
  try {
    const compiler = await BabaGpuLazuliCompiler.create(runtime, planBytes);
    const sourceByteLength = MAXIMUM_SOURCE_BYTE_LENGTH + 2;
    const source = "\u0800".repeat(sourceByteLength / 3);
    const compilation = await compiler.compile(source);

    equal(compilation.frontendTimings, null);
    deepStrictEqual(compilation.result, {
      ok: false,
      diagnostics: [
        sourceTooLargeDiagnostic(sourceByteLength, MAXIMUM_SOURCE_BYTE_LENGTH),
      ],
    });
  } finally {
    runtime.dispose();
  }
});

function reverseNonrootNodes(program: CompactFrontendProgram): CompactFrontendProgram {
  const nodeWordLength = 8;
  const edgeWordLength = 4;
  const nodeCount = program.nodes.length / nodeWordLength;
  const reorderedNodes = new Int32Array(program.nodes.length);
  const reorderedNodeId = (nodeId: number): number => nodeId === 0 ? 0 : nodeCount - nodeId;

  for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
    const reorderedId = reorderedNodeId(nodeId);
    reorderedNodes.set(
      program.nodes.subarray(nodeId * nodeWordLength, (nodeId + 1) * nodeWordLength),
      reorderedId * nodeWordLength,
    );
  }

  const reorderedEdges = new Int32Array(program.edges);
  for (let edgeOffset = 0; edgeOffset < reorderedEdges.length; edgeOffset += edgeWordLength) {
    const targetCategory = reorderedEdges[edgeOffset + 2];
    if (targetCategory === 1) {
      const target = reorderedEdges[edgeOffset + 3];
      if (target === undefined) {
        throw new Error(`Baba test edge ${edgeOffset / edgeWordLength} has no target.`);
      }
      reorderedEdges[edgeOffset + 3] = reorderedNodeId(target);
    }
  }

  return {
    ...program,
    nodes: reorderedNodes,
    edges: reorderedEdges,
  };
}
