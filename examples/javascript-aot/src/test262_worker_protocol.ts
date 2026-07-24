import type {
  Test262ExecutionCaseResult,
  Test262ExecutionRequest,
  Test262ExecutionResponse,
} from "./test262_execute.ts";
import type { Test262ExecutionMode, Test262Metadata } from "./test262.ts";

export type Test262WorkerRequest =
  | {
    readonly type: "execute";
    readonly requestId: number;
    readonly request: Test262ExecutionRequest;
  }
  | { readonly type: "close" };

export type Test262WorkerResponse =
  | { readonly type: "ready" }
  | {
    readonly type: "result";
    readonly requestId: number;
    readonly response: Test262ExecutionResponse;
  };

const encoder = new TextEncoder();

export function encodeTest262WorkerMessage(
  message: Test262WorkerRequest | Test262WorkerResponse,
): Uint8Array {
  return encoder.encode(`${JSON.stringify(message)}\n`);
}

export function parseTest262WorkerRequest(line: string): Test262WorkerRequest {
  const parsed = parseRecord(line, "request");
  if (parsed.type === "close") return { type: "close" };
  if (
    parsed.type !== "execute" ||
    typeof parsed.requestId !== "number" ||
    !Number.isSafeInteger(parsed.requestId) ||
    parsed.requestId < 0
  ) {
    throw new Error(`Invalid Test262 execution worker request: ${line}`);
  }
  return {
    type: "execute",
    requestId: parsed.requestId,
    request: parseExecutionRequest(parsed.request, line),
  };
}

export function parseTest262WorkerResponse(line: string): Test262WorkerResponse {
  const parsed = parseRecord(line, "response");
  if (parsed.type === "ready") return { type: "ready" };
  if (
    parsed.type !== "result" ||
    typeof parsed.requestId !== "number" ||
    !Number.isSafeInteger(parsed.requestId) ||
    parsed.requestId < 0
  ) {
    throw new Error(`Invalid Test262 execution worker response: ${line}`);
  }
  return {
    type: "result",
    requestId: parsed.requestId,
    response: parseExecutionResponse(parsed.response, line),
  };
}

export async function* readNdjsonLines(
  readable: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const lineEnd = pending.indexOf("\n");
        if (lineEnd === -1) break;
        const line = pending.slice(0, lineEnd);
        pending = pending.slice(lineEnd + 1);
        if (line.length > 0) yield line;
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) yield pending;
  } finally {
    reader.releaseLock();
  }
}

function parseRecord(line: string, direction: "request" | "response"): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid Test262 execution worker ${direction} JSON: ${line}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Test262 execution worker ${direction}: ${line}`);
  }
  return parsed as Record<string, unknown>;
}

function parseExecutionRequest(candidate: unknown, line: string): Test262ExecutionRequest {
  if (!isRecord(candidate) || typeof candidate.entryName !== "string") {
    throw new Error(`Invalid Test262 execution worker request: ${line}`);
  }
  const executionCase = candidate.executionCase;
  if (
    !isRecord(executionCase) ||
    typeof executionCase.absolutePath !== "string" ||
    typeof executionCase.path !== "string" ||
    !isExecutionMode(executionCase.mode) ||
    !isMetadata(executionCase.metadata) ||
    (
      executionCase.expectedRuntimeErrorType !== null &&
      typeof executionCase.expectedRuntimeErrorType !== "string"
    )
  ) {
    throw new Error(`Invalid Test262 execution worker request: ${line}`);
  }
  return {
    executionCase: {
      absolutePath: executionCase.absolutePath,
      path: executionCase.path,
      mode: executionCase.mode,
      metadata: executionCase.metadata,
      expectedRuntimeErrorType: executionCase.expectedRuntimeErrorType,
    },
    entryName: candidate.entryName,
  };
}

function parseExecutionResponse(candidate: unknown, line: string): Test262ExecutionResponse {
  if (!isRecord(candidate) || typeof candidate.ok !== "boolean") {
    throw new Error(`Invalid Test262 execution worker response: ${line}`);
  }
  if (candidate.ok) {
    return { ok: true, result: parseExecutionResult(candidate.result, line) };
  }
  if (
    typeof candidate.message !== "string" ||
    (candidate.stack !== null && typeof candidate.stack !== "string")
  ) {
    throw new Error(`Invalid Test262 execution worker response: ${line}`);
  }
  return { ok: false, message: candidate.message, stack: candidate.stack };
}

function parseExecutionResult(candidate: unknown, line: string): Test262ExecutionCaseResult {
  if (!isRecord(candidate) || typeof candidate.kind !== "string") {
    throw new Error(`Invalid Test262 execution worker response: ${line}`);
  }
  if (candidate.kind === "passed") {
    if (candidate.expectation !== "positive" && candidate.expectation !== "runtime-negative") {
      throw new Error(`Invalid Test262 execution worker response: ${line}`);
    }
    return { kind: "passed", expectation: candidate.expectation };
  }
  if (
    (
      candidate.kind !== "resource-limited" &&
      candidate.kind !== "compilation-failed" &&
      candidate.kind !== "execution-failed"
    ) ||
    typeof candidate.reason !== "string"
  ) {
    throw new Error(`Invalid Test262 execution worker response: ${line}`);
  }
  return { kind: candidate.kind, reason: candidate.reason };
}

function isExecutionMode(candidate: unknown): candidate is Test262ExecutionMode {
  return candidate === "non-strict" ||
    candidate === "strict" ||
    candidate === "module" ||
    candidate === "raw";
}

function isMetadata(candidate: unknown): candidate is Test262Metadata {
  if (
    !isRecord(candidate) ||
    !isStringArray(candidate.flags) ||
    !isStringArray(candidate.features) ||
    !isStringArray(candidate.includes)
  ) {
    return false;
  }
  if (candidate.negative === null) return true;
  return isRecord(candidate.negative) &&
    (
      candidate.negative.phase === "parse" ||
      candidate.negative.phase === "resolution" ||
      candidate.negative.phase === "runtime"
    ) &&
    typeof candidate.negative.type === "string";
}

function isStringArray(candidate: unknown): candidate is readonly string[] {
  return Array.isArray(candidate) &&
    candidate.every((element) => typeof element === "string");
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}
