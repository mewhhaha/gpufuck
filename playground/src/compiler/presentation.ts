import { type FunctionalWasmValue } from "../../../src/functional/wasm_execution.ts";

export function describeFailure(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  return cause.cause === undefined
    ? cause.message
    : `${cause.message}: ${describeFailure(cause.cause)}`;
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "—";
  if (milliseconds < 0.1) return `${Math.round(milliseconds * 1_000)} µs`;
  if (milliseconds < 10) return `${milliseconds.toFixed(2)} ms`;
  return `${milliseconds.toFixed(1)} ms`;
}

export function formatByteLength(byteLength: number | undefined): string {
  if (byteLength === undefined) return "—";
  if (byteLength < 1_000) return `${byteLength} B`;
  return `${(byteLength / 1_000).toFixed(1)} kB`;
}

export function formatValue(value: FunctionalWasmValue): string {
  switch (value.kind) {
    case "integer":
    case "float-32":
    case "float-64":
    case "boolean":
      return String(value.value);
    case "signed-integer-64":
      return value.value.toString();
    case "unit":
      return "()";
    case "text":
      return JSON.stringify(value.value);
    case "bytes":
      return `bytes [${[...value.value].join(", ")}]`;
    case "array":
      return `[${value.values.map(formatValue).join(", ")}]`;
    case "slice":
      return `slice [${value.values.map(formatValue).join(", ")}]`;
    case "resource":
      return `resource ${value.id}`;
    case "erased":
      return formatValue(value.value);
    case "tuple":
      return `(${value.values.map(formatValue).join(", ")})`;
    case "constructor":
      return value.fields.length === 0
        ? value.name
        : `${value.name} (${value.fields.map(formatValue).join(", ")})`;
  }
}

export function sourceLocation(source: string, byteOffset: number): string {
  const index = utf16IndexAtByte(source, byteOffset);
  const prefix = source.slice(0, index);
  const line = prefix.split("\n").length;
  const previousLineBreak = prefix.lastIndexOf("\n");
  return `${line}:${index - previousLineBreak}`;
}

export function utf16IndexAtByte(source: string, targetByteOffset: number): number {
  const encoder = new TextEncoder();
  let byteOffset = 0;
  let utf16Index = 0;
  for (const character of source) {
    if (byteOffset >= targetByteOffset) break;
    byteOffset += encoder.encode(character).byteLength;
    utf16Index += character.length;
  }
  return utf16Index;
}
