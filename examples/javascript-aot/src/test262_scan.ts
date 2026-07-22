import type { JavaScriptAotDiagnostic } from "./diagnostic.ts";
import {
  classifyTest262CoreTest,
  parseTest262Metadata,
  type Test262ExecutionMode,
  test262ExecutionModes,
  test262FrontendProbeSource,
  type Test262Metadata,
} from "./test262.ts";
import {
  lowerTest262NegativeTest,
  lowerTest262PositiveTest,
  probeTest262NegativeTest,
} from "./test262_harness.ts";

export interface Test262FrontendBatchRequest {
  readonly checkout: string;
  readonly absolutePaths: readonly string[];
  readonly entryName: string;
}

export type Test262FrontendBatchResponse =
  | { readonly ok: true; readonly probes: readonly Test262FrontendFileProbe[] }
  | { readonly ok: false; readonly message: string; readonly stack: string | null };

export type Test262FrontendFileProbe =
  | {
    readonly kind: "fixture";
    readonly absolutePath: string;
    readonly path: string;
  }
  | {
    readonly kind: "excluded";
    readonly absolutePath: string;
    readonly path: string;
  }
  | {
    readonly kind: "applicable";
    readonly absolutePath: string;
    readonly path: string;
    readonly metadata: Test262Metadata;
    readonly executionModes: readonly Test262ExecutionMode[];
    readonly outcomes: readonly Test262FrontendModeProbe[];
  };

export type Test262FrontendModeProbe =
  | { readonly kind: "ready"; readonly mode: Test262ExecutionMode }
  | {
    readonly kind: "negative-ready";
    readonly mode: Test262ExecutionMode;
    readonly phase: "parse" | "resolution" | "runtime";
    readonly expectedType: string;
  }
  | {
    readonly kind: "unsupported";
    readonly mode: Test262ExecutionMode;
    readonly diagnostic: JavaScriptAotDiagnostic;
    readonly lexeme: string | null;
  };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function probeTest262FrontendBatch(
  request: Test262FrontendBatchRequest,
): Promise<readonly Test262FrontendFileProbe[]> {
  const probes: Test262FrontendFileProbe[] = [];
  for (const absolutePath of request.absolutePaths) {
    const path = relativeTest262Path(request.checkout, absolutePath);
    const disposition = classifyTest262CoreTest(path);
    if (disposition.kind === "fixture") {
      probes.push({ kind: "fixture", absolutePath, path });
      continue;
    }
    if (disposition.kind === "excluded") {
      probes.push({ kind: "excluded", absolutePath, path });
      continue;
    }
    const source = await Deno.readTextFile(absolutePath);
    probes.push(probeApplicableTest262Source(absolutePath, path, source, request.entryName));
  }
  return probes;
}

export function probeApplicableTest262Source(
  absolutePath: string,
  path: string,
  source: string,
  entryName: string,
): Extract<Test262FrontendFileProbe, { readonly kind: "applicable" }> {
  const metadata = parseTest262Metadata(path, source);
  const executionModes = test262ExecutionModes(metadata);
  const negativeExpectation = metadata.negative;
  if (negativeExpectation !== null) {
    const outcomes = executionModes.map((mode): Test262FrontendModeProbe => {
      const result = negativeExpectation.phase === "runtime"
        ? lowerTest262NegativeTest(path, source, metadata, entryName, mode)
        : probeTest262NegativeTest(path, source, metadata, entryName, mode);
      if (result.kind === "mismatch") {
        return {
          kind: "unsupported",
          mode,
          diagnostic: result.diagnostic,
          lexeme: null,
        };
      }
      return {
        kind: "negative-ready",
        mode,
        phase: result.kind === "matched" ? result.phase : "runtime",
        expectedType: negativeExpectation.type,
      };
    });
    return { kind: "applicable", absolutePath, path, metadata, executionModes, outcomes };
  }

  const outcomes = executionModes.map((mode): Test262FrontendModeProbe => {
    const frontend = lowerTest262PositiveTest(path, source, metadata, entryName, mode);
    if (frontend.ok) return { kind: "ready", mode };
    const diagnostic = frontend.diagnostics[0];
    return {
      kind: "unsupported",
      mode,
      diagnostic,
      lexeme: diagnostic.stage === "parse"
        ? diagnosticLexeme(source, metadata, entryName, mode, diagnostic)
        : null,
    };
  });
  return { kind: "applicable", absolutePath, path, metadata, executionModes, outcomes };
}

function relativeTest262Path(checkout: string, absolutePath: string): string {
  const prefix = `${checkout}/`;
  if (!absolutePath.startsWith(prefix)) {
    throw new Error(
      `Test262 path ${JSON.stringify(absolutePath)} is outside checkout ${
        JSON.stringify(checkout)
      }.`,
    );
  }
  return absolutePath.slice(prefix.length);
}

function diagnosticLexeme(
  source: string,
  metadata: Test262Metadata,
  entryName: string,
  mode: Test262ExecutionMode,
  diagnostic: JavaScriptAotDiagnostic,
): string {
  const probeSource = test262FrontendProbeSource(source, metadata, entryName, mode);
  if (probeSource === null) {
    throw new Error(
      `Positive Test262 mode ${mode} produced no frontend probe for diagnostic ${diagnostic.code}.`,
    );
  }
  const probeBytes = textEncoder.encode(probeSource);
  return textDecoder.decode(
    probeBytes.subarray(diagnostic.span.startByte, diagnostic.span.endByte),
  );
}
