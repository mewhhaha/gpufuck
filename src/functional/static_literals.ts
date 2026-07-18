const BYTES_LITERAL_PREFIX = "$bytes:";

export function functionalBytesLiteralSymbol(bytes: Uint8Array): string {
  return BYTES_LITERAL_PREFIX +
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function functionalBytesFromLiteralSymbol(symbol: string): Uint8Array {
  if (!symbol.startsWith(BYTES_LITERAL_PREFIX)) {
    throw new Error(`functional bytes literal has invalid symbol ${JSON.stringify(symbol)}`);
  }
  const hex = symbol.slice(BYTES_LITERAL_PREFIX.length);
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error(
      `functional bytes literal symbol contains malformed hexadecimal bytes: ${
        JSON.stringify(symbol)
      }`,
    );
  }
  return Uint8Array.from(
    { length: hex.length / 2 },
    (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}
