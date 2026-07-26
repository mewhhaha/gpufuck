/**
 * A structural reader for the emitted WebAssembly, so the playground can show the module rather than
 * only offer it as a download.
 *
 * This is not a disassembler. Instruction-level text would mean implementing the whole opcode table
 * for a page whose job is to show that something real came out the other end; the section table plus
 * exported signatures answers that and is a few hundred bytes of code. If full WAT is ever wanted,
 * `wasm2wat` is the honest way to get it, not this file growing.
 *
 * @module
 */

/** Section ids from the core specification, in binary order. */
const SECTION_NAMES: Readonly<Record<number, string>> = {
  0: "custom",
  1: "type",
  2: "import",
  3: "function",
  4: "table",
  5: "memory",
  6: "global",
  7: "export",
  8: "start",
  9: "element",
  10: "code",
  11: "data",
  12: "data count",
};

const VALUE_TYPES: Readonly<Record<number, string>> = {
  0x7f: "i32",
  0x7e: "i64",
  0x7d: "f32",
  0x7c: "f64",
  0x7b: "v128",
  0x70: "funcref",
  0x6f: "externref",
};

export interface WasmSection {
  readonly id: number;
  readonly name: string;
  readonly byteLength: number;
}

export interface WasmExport {
  readonly name: string;
  readonly kind: string;
  readonly signature: string | undefined;
}

export interface WasmOutline {
  readonly byteLength: number;
  readonly sections: readonly WasmSection[];
  readonly typeCount: number;
  readonly importCount: number;
  readonly functionCount: number;
  readonly exports: readonly WasmExport[];
  readonly memoryPages: number | undefined;
}

class Reader {
  #bytes: Uint8Array;
  #at = 0;

  constructor(bytes: Uint8Array, at = 0) {
    this.#bytes = bytes;
    this.#at = at;
  }

  get offset(): number {
    return this.#at;
  }

  get done(): boolean {
    return this.#at >= this.#bytes.length;
  }

  byte(): number {
    const value = this.#bytes[this.#at];
    if (value === undefined) throw new RangeError("WebAssembly outline read past the end");
    this.#at += 1;
    return value;
  }

  /** Unsigned LEB128, which is how every length and index in the format is written. */
  varUint(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 35) throw new RangeError("WebAssembly outline met an overlong LEB128");
    }
  }

  skip(count: number): void {
    this.#at += count;
  }

  slice(count: number): Uint8Array {
    const view = this.#bytes.subarray(this.#at, this.#at + count);
    this.#at += count;
    return view;
  }

  name(): string {
    return new TextDecoder().decode(this.slice(this.varUint()));
  }
}

function functionType(reader: Reader): string {
  if (reader.byte() !== 0x60) return "?";
  const parameters = Array.from(
    { length: reader.varUint() },
    () => VALUE_TYPES[reader.byte()] ?? "?",
  );
  const results = Array.from({ length: reader.varUint() }, () => VALUE_TYPES[reader.byte()] ?? "?");
  const returns = results.length === 0 ? "" : ` -> ${results.join(", ")}`;
  return `(${parameters.join(", ")})${returns}`;
}

const EXPORT_KINDS = ["func", "table", "memory", "global"] as const;

/**
 * Reads the module's shape. Returns `undefined` rather than throwing on anything unexpected — this
 * feeds a display panel, and a malformed byte should cost the panel, not the compile that produced
 * a module which already ran.
 */
export function readWasmOutline(bytes: Uint8Array): WasmOutline | undefined {
  try {
    const reader = new Reader(bytes);
    for (const expected of [0x00, 0x61, 0x73, 0x6d]) {
      if (reader.byte() !== expected) return undefined;
    }
    reader.skip(4); // version

    const sections: WasmSection[] = [];
    const signatures: string[] = [];
    const functionTypes: number[] = [];
    const exports: WasmExport[] = [];
    let importCount = 0;
    let memoryPages: number | undefined;

    while (!reader.done) {
      const id = reader.byte();
      const byteLength = reader.varUint();
      const end = reader.offset + byteLength;
      sections.push({ id, name: SECTION_NAMES[id] ?? `unknown ${id}`, byteLength });
      const body = new Reader(bytes, reader.offset);
      if (id === 1) {
        for (let index = body.varUint(); index > 0; index--) signatures.push(functionType(body));
      } else if (id === 2) {
        // Only imported *functions* shift the function index space, so tables, memories and globals
        // in here must not be counted or every exported signature would come out shifted.
        for (let index = body.varUint(); index > 0; index--) {
          body.name();
          body.name();
          const kind = body.byte();
          if (kind === 0x00) {
            importCount += 1;
            body.varUint();
          } else if (kind === 0x01) {
            body.byte();
            if (body.byte() === 0x01) body.varUint();
            body.varUint();
          } else if (kind === 0x02) {
            if (body.byte() === 0x01) body.varUint();
            body.varUint();
          } else {
            body.byte();
            body.byte();
          }
        }
      } else if (id === 3) {
        for (let index = body.varUint(); index > 0; index--) functionTypes.push(body.varUint());
      } else if (id === 5) {
        if (body.varUint() > 0) {
          const limits = body.byte();
          memoryPages = body.varUint();
          if (limits === 0x01) body.varUint();
        }
      } else if (id === 7) {
        for (let index = body.varUint(); index > 0; index--) {
          const name = body.name();
          const kind = EXPORT_KINDS[body.byte()] ?? "?";
          const target = body.varUint();
          const typeIndex = kind === "func" ? functionTypes[target - importCount] : undefined;
          exports.push({
            name,
            kind,
            signature: typeIndex === undefined ? undefined : signatures[typeIndex],
          });
        }
      }
      reader.skip(byteLength);
      if (reader.offset !== end) return undefined;
    }

    return {
      byteLength: bytes.byteLength,
      sections,
      typeCount: signatures.length,
      importCount,
      functionCount: functionTypes.length,
      exports,
      memoryPages,
    };
  } catch {
    return undefined;
  }
}
