// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Host implementations used by the executable agreement catalog.
//
// Production callers provide the imports named by the build manifest. These
// implementations are deliberately strict so a compiler/host ABI disagreement
// fails at the boundary instead of being converted into a plausible value.

import type { WasmHostValue, WasmInit } from "../../../../functional.ts";

export function hostInit(write: (line: string) => void): WasmInit {
  return {
    Text: {
      length: (value) => {
        const text = requireText(value, "Text.length argument");
        return {
          kind: "signed-integer-64",
          value: BigInt([...text].length),
        };
      },
      of_int: (value) => {
        const integer = requireInteger(value, "Text.of_int argument");
        return { kind: "text", value: String(integer) };
      },
      compare: (value) => {
        if (value.kind !== "constructor" || value.fields.length !== 2) {
          throw new TypeError(
            `Text.compare argument must be a two-field constructor; received ${describe(value)}`,
          );
        }
        const left = requireText(value.fields[0], "Text.compare left argument");
        const right = requireText(
          value.fields[1],
          "Text.compare right argument",
        );
        let ordering = 0n;
        const leftScalars = [...left];
        const rightScalars = [...right];
        const length = Math.min(leftScalars.length, rightScalars.length);
        for (let index = 0; index < length; index += 1) {
          const leftScalar = leftScalars[index]!.codePointAt(0)!;
          const rightScalar = rightScalars[index]!.codePointAt(0)!;
          if (leftScalar < rightScalar) {
            ordering = -1n;
            break;
          }
          if (leftScalar > rightScalar) {
            ordering = 1n;
            break;
          }
        }
        if (ordering === 0n && leftScalars.length < rightScalars.length) {
          ordering = -1n;
        }
        if (ordering === 0n && leftScalars.length > rightScalars.length) {
          ordering = 1n;
        }
        return { kind: "signed-integer-64", value: ordering };
      },
      contains: (value) => {
        if (value.kind !== "constructor" || value.fields.length !== 2) {
          throw new TypeError(
            `Text.contains argument must be a two-field constructor; received ${describe(value)}`,
          );
        }
        const text = requireText(value.fields[0], "Text.contains text");
        const query = requireText(value.fields[1], "Text.contains query");
        return { kind: "boolean", value: text.includes(query) };
      },
    },
    Init: {
      print: (value) => {
        write(requireText(value, "Init.print argument"));
        return { kind: "unit" };
      },
    },
    Console: {
      write: (value) => {
        write(requireText(value, "Console.write argument"));
        return { kind: "unit" };
      },
    },
  };
}

function requireText(value: WasmHostValue, location: string): string {
  if (value.kind === "text") return value.value;
  throw new TypeError(`${location} must be text; received ${describe(value)}`);
}

function requireInteger(value: WasmHostValue, location: string): bigint {
  if (value.kind === "signed-integer-64") return value.value;
  throw new TypeError(
    `${location} must be a signed i64; received ${describe(value)}`,
  );
}

function describe(value: WasmHostValue): string {
  if ("value" in value) {
    return `${value.kind} ${String(value.value)}`;
  }
  return value.kind;
}
