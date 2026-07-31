import {
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
  }>
  | undefined;

async function syntaxSession(planUrl: URL) {
  if (session !== undefined) return await session;
  session = (async () => {
    const response = await fetch(planUrl);
    if (!response.ok) {
      throw new Error(`Blot GPU parser plan fetch failed with HTTP ${response.status}.`);
    }
    const plan = new Uint8Array(await response.arrayBuffer());
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
    };
  })();
  return await session;
}

export async function validateBlotSyntax(source: string, planUrl: URL): Promise<GpuSyntaxResult> {
  const { frontend, adapter } = await syntaxSession(planUrl);
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
    adapter,
  };
}
