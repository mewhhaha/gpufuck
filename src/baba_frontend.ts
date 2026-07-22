export interface BabaUtf16Span {
  readonly start: number;
  readonly end: number;
}

export interface BabaRuleCursor {
  readonly type: "rule";
  readonly name: string;
  readonly span: BabaUtf16Span;
  children(): readonly unknown[];
  field(name: string): unknown;
  fieldArray(name: string): readonly unknown[];
}

export interface BabaTokenCursor {
  readonly type: "token";
  readonly text: string;
  readonly span: BabaUtf16Span;
}

export class BabaUtf8ByteOffsets {
  readonly #offsets: Uint32Array;

  constructor(private readonly source: string) {
    this.#offsets = new Uint32Array(source.length + 1);
    let byteOffset = 0;
    for (let index = 0; index < source.length; index++) {
      this.#offsets[index] = byteOffset;
      const codePoint = source.codePointAt(index)!;
      byteOffset += utf8Width(codePoint);
      if (codePoint > 0xffff) {
        index++;
        this.#offsets[index] = byteOffset;
      }
    }
    this.#offsets[source.length] = byteOffset;
  }

  get byteLength(): number {
    return this.#offsets[this.#offsets.length - 1]!;
  }

  span(span: BabaUtf16Span): { readonly startByte: number; readonly endByte: number } {
    return {
      startByte: this.#offsets[span.start] ?? this.byteLength,
      endByte: this.#offsets[span.end] ?? this.byteLength,
    };
  }

  text(span: BabaUtf16Span): string {
    return this.source.slice(span.start, span.end);
  }
}

export function isBabaRuleCursor(value: unknown): value is BabaRuleCursor {
  return !!value && typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "rule";
}

export function isBabaTokenCursor(value: unknown): value is BabaTokenCursor {
  return !!value && typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "token" &&
    typeof (value as { readonly text?: unknown }).text === "string";
}

export function babaChildRule(node: BabaRuleCursor): BabaRuleCursor {
  const child = node.children().find(isBabaRuleCursor);
  if (child === undefined) throw new Error(`Expected a child rule on ${node.name}.`);
  return child;
}

export function babaRequiredRuleField(node: BabaRuleCursor, name: string): BabaRuleCursor {
  const value = node.field(name);
  if (!isBabaRuleCursor(value)) {
    throw new Error(`Expected rule field ${JSON.stringify(name)} on ${node.name}.`);
  }
  return value;
}

export function babaOptionalRuleField(
  node: BabaRuleCursor,
  name: string,
): BabaRuleCursor | null {
  const value = node.field(name);
  if (value === undefined || value === null) return null;
  if (!isBabaRuleCursor(value)) {
    throw new Error(`Expected optional rule field ${JSON.stringify(name)} on ${node.name}.`);
  }
  return value;
}

export function babaRequiredTokenField(node: BabaRuleCursor, name: string): BabaTokenCursor {
  const value = node.field(name);
  if (!isBabaTokenCursor(value)) {
    throw new Error(`Expected token field ${JSON.stringify(name)} on ${node.name}.`);
  }
  return value;
}

export function babaOptionalTokenField(
  node: BabaRuleCursor,
  name: string,
): BabaTokenCursor | null {
  const value = node.field(name);
  if (value === undefined || value === null) return null;
  if (!isBabaTokenCursor(value)) {
    throw new Error(`Expected optional token field ${JSON.stringify(name)} on ${node.name}.`);
  }
  return value;
}

export function babaRuleFieldArray(
  node: BabaRuleCursor,
  name: string,
): readonly BabaRuleCursor[] {
  return node.fieldArray(name).map((value) => {
    if (!isBabaRuleCursor(value)) {
      throw new Error(`Expected rule array field ${JSON.stringify(name)} on ${node.name}.`);
    }
    return value;
  });
}

export function babaTokenFieldArray(
  node: BabaRuleCursor,
  name: string,
): readonly BabaTokenCursor[] {
  return node.fieldArray(name).map((value) => {
    if (!isBabaTokenCursor(value)) {
      throw new Error(`Expected token array field ${JSON.stringify(name)} on ${node.name}.`);
    }
    return value;
  });
}

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
