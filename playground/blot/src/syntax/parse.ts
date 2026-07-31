// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// The parse entry point. Deliberately never touches WebGPU: `blot check`, the
// formatter, and the language server all come through here, and none of them
// should initialize a device. The GPU frontend is a throughput path for large
// inputs, not the definition of the syntax.

import { createParser, type ParserInstance } from "../../generated/wasm/mod.ts";
import type { Diagnostic } from "../diagnostic.ts";
import { BlotError } from "../diagnostic.ts";
import type { Module } from "./ast.ts";
import { lowerModule, type Rule } from "./lower.ts";

let shared: ParserInstance | null = null;

function parser(): ParserInstance {
  if (shared !== null) return shared;
  throw new Error("Blot parser assets were not initialized.");
}

export async function initializeBlotParser(wasmUrl: URL, planUrl: URL): Promise<void> {
  if (shared !== null) return;
  const [wasmResponse, planResponse] = await Promise.all([
    fetch(wasmUrl),
    fetch(planUrl),
  ]);
  if (!wasmResponse.ok) {
    throw new Error(`Blot parser fetch failed with HTTP ${wasmResponse.status}.`);
  }
  if (!planResponse.ok) {
    throw new Error(`Blot parser plan fetch failed with HTTP ${planResponse.status}.`);
  }
  shared = createParser({
    bytes: new Uint8Array(await wasmResponse.arrayBuffer()),
    plan: new Uint8Array(await planResponse.arrayBuffer()),
  });
}

export type ParseResult =
  | { readonly ok: true; readonly module: Module }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export function parse(source: string): ParseResult {
  const instance = parser();
  const result = instance.parse(source);
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        span: diagnostic.span,
      })),
    };
  }

  try {
    return {
      ok: true,
      module: lowerModule(result.cursor as unknown as Rule, source),
    };
  } catch (error) {
    if (error instanceof BlotError) {
      return { ok: false, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
}

export function dispose(): void {
  if (shared !== null) {
    shared.dispose();
    shared = null;
  }
}
