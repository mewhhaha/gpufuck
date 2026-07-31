import {
  decodeLexerPlanTables,
  type FrontendDiagnostic,
  type GpuFrontendTimings,
  WebGpuRuntime,
} from "@mewhhaha/blot-baba/runtime/webgpu";

export type GpuSyntaxResult =
  | {
    readonly ok: true;
    readonly timings: GpuFrontendTimings;
    readonly tokenWords: number;
    readonly nodeWords: number;
    readonly edgeWords: number;
    readonly lexerRecords: Int32Array;
    readonly adapter: string;
  }
  | {
    readonly ok: false;
    readonly timings: GpuFrontendTimings;
    readonly diagnostics: readonly FrontendDiagnostic[];
    readonly adapter: string;
  };

let session:
  | Promise<{
    readonly runtime: WebGpuRuntime;
    readonly frontend: Awaited<ReturnType<WebGpuRuntime["compileFrontend"]>>;
    readonly adapter: string;
    readonly acceptingStateBySpec: Int32Array;
  }>
  | undefined;

export async function resetBlotSyntaxSession(): Promise<void> {
  const active = session;
  session = undefined;
  if (active === undefined) return;
  (await active).runtime.dispose();
}

async function syntaxSession(planUrl: URL) {
  if (session !== undefined) return await session;
  const pending = (async () => {
    const response = await fetch(planUrl);
    if (!response.ok) {
      throw new Error(`Blot GPU parser plan fetch failed with HTTP ${response.status}.`);
    }
    const plan = new Uint8Array(await response.arrayBuffer());
    const lexerPlan = decodeLexerPlanTables(plan);
    const acceptingStateBySpec = new Int32Array(lexerPlan.specCount).fill(-1);
    for (const [state, spec] of lexerPlan.acceptSpecByState.entries()) {
      if (spec >= 0 && acceptingStateBySpec[spec] === -1) acceptingStateBySpec[spec] = state;
    }
    const runtime = await WebGpuRuntime.create({
      powerPreference: "high-performance",
      allowFallbackAdapter: true,
    });
    const frontend = await runtime.compileFrontend(plan);
    const { vendor, architecture } = runtime.capabilities;
    return {
      runtime,
      frontend,
      adapter: [vendor, architecture].filter((part) => part !== "unavailable").join(" ") ||
        "unnamed adapter",
      acceptingStateBySpec,
    };
  })();
  session = pending;
  try {
    return await pending;
  } catch (error) {
    if (session === pending) session = undefined;
    throw error;
  }
}

export async function validateBlotSyntax(source: string, planUrl: URL): Promise<GpuSyntaxResult> {
  const { frontend, adapter, acceptingStateBySpec } = await syntaxSession(planUrl);
  const result = await frontend.ingest(source, { stageTimings: "collect" });
  if (!result.ok) {
    return {
      ok: false,
      timings: result.timings,
      diagnostics: result.diagnostics,
      adapter,
    };
  }
  return {
    ok: true,
    timings: result.timings,
    tokenWords: result.program.tokens.length,
    nodeWords: result.program.nodes.length,
    edgeWords: result.program.edges.length,
    lexerRecords: externalLexerRecords(result.program.tokens, acceptingStateBySpec),
    adapter,
  };
}

function externalLexerRecords(
  tokens: Int32Array,
  acceptingStateBySpec: Int32Array,
): Int32Array {
  const records = new Int32Array(tokens.length);
  for (let offset = 0; offset < tokens.length; offset += 4) {
    const spec = tokens[offset + 3];
    const start = tokens[offset + 1];
    const end = tokens[offset + 2];
    if (spec === undefined || start === undefined || end === undefined) {
      throw new Error(`Blot GPU token record at word ${offset} is incomplete.`);
    }
    const acceptingState = acceptingStateBySpec[spec];
    if (spec < 0 || acceptingState === undefined || acceptingState < 0) {
      throw new Error(
        `Blot GPU token record at word ${offset} has unmapped lexer specification ${spec}.`,
      );
    }
    records[offset] = spec;
    records[offset + 1] = start;
    records[offset + 2] = end;
    records[offset + 3] = acceptingState;
  }
  return records;
}
