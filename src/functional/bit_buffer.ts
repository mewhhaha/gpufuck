import type { FunctionalWasmHostValue } from "./wasm_contract.ts";

export interface FunctionalBitBuffer {
  readonly bytes: Uint8Array;
  readonly bitLength: number;
}

export function functionalBitBuffer(
  bytes: Uint8Array,
  bitLength: number,
): FunctionalBitBuffer {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(
      `functional bit buffer bytes must be Uint8Array; received ${
        Object.prototype.toString.call(bytes)
      }`,
    );
  }
  if (!Number.isSafeInteger(bitLength) || bitLength < 0 || bitLength > bytes.byteLength * 8) {
    throw new RangeError(
      `functional bit buffer length ${bitLength} is outside 0..${bytes.byteLength * 8}`,
    );
  }
  const copied = bytes.slice(0, Math.ceil(bitLength / 8));
  if (bitLength % 8 !== 0 && copied.length !== 0) {
    const retainedBits = bitLength % 8;
    const finalIndex = copied.length - 1;
    copied[finalIndex] = copied[finalIndex]! & (0xff << (8 - retainedBits));
  }
  return Object.freeze({ bytes: copied, bitLength });
}

export function functionalBitBufferHostValue(
  buffer: FunctionalBitBuffer,
): Extract<FunctionalWasmHostValue, { readonly kind: "tuple" }> {
  const normalized = functionalBitBuffer(buffer.bytes, buffer.bitLength);
  return {
    kind: "tuple",
    values: [
      { kind: "bytes", value: normalized.bytes },
      { kind: "integer", value: normalized.bitLength },
    ],
  };
}

export function functionalBitBufferFromHostValue(
  value: FunctionalWasmHostValue,
): FunctionalBitBuffer {
  if (value.kind !== "tuple" || value.values.length !== 2) {
    throw new TypeError(
      `functional bit buffer host value must be a (Bytes, Int) tuple; received ${
        value.kind === "tuple" ? `tuple with ${value.values.length} values` : value.kind
      }`,
    );
  }
  const [bytes, bitLength] = value.values;
  if (bytes!.kind !== "bytes" || bitLength!.kind !== "integer") {
    throw new TypeError(
      `functional bit buffer host value must be a (Bytes, Int) tuple; received (${bytes!.kind}, ${
        bitLength!.kind
      })`,
    );
  }
  return functionalBitBuffer(bytes!.value, bitLength!.value);
}

export function appendFunctionalBitBuffers(
  left: FunctionalBitBuffer,
  right: FunctionalBitBuffer,
): FunctionalBitBuffer {
  const normalizedLeft = functionalBitBuffer(left.bytes, left.bitLength);
  const normalizedRight = functionalBitBuffer(right.bytes, right.bitLength);
  const bitLength = normalizedLeft.bitLength + normalizedRight.bitLength;
  if (!Number.isSafeInteger(bitLength)) {
    throw new RangeError(
      `functional bit buffer append length exceeds safe integer: ${normalizedLeft.bitLength} + ${normalizedRight.bitLength}`,
    );
  }
  const bytes = new Uint8Array(Math.ceil(bitLength / 8));
  for (let index = 0; index < normalizedLeft.bitLength; index++) {
    if (bitAt(normalizedLeft, index)) setBit(bytes, index);
  }
  for (let index = 0; index < normalizedRight.bitLength; index++) {
    if (bitAt(normalizedRight, index)) setBit(bytes, normalizedLeft.bitLength + index);
  }
  return functionalBitBuffer(bytes, bitLength);
}

export function sliceFunctionalBitBuffer(
  buffer: FunctionalBitBuffer,
  startBit: number,
  endBit: number,
): FunctionalBitBuffer {
  const normalized = functionalBitBuffer(buffer.bytes, buffer.bitLength);
  if (
    !Number.isSafeInteger(startBit) || !Number.isSafeInteger(endBit) || startBit < 0 ||
    endBit < startBit || endBit > normalized.bitLength
  ) {
    throw new RangeError(
      `functional bit buffer slice ${startBit}..${endBit} is outside 0..${normalized.bitLength}`,
    );
  }
  const bitLength = endBit - startBit;
  const bytes = new Uint8Array(Math.ceil(bitLength / 8));
  for (let index = 0; index < bitLength; index++) {
    if (bitAt(normalized, startBit + index)) setBit(bytes, index);
  }
  return functionalBitBuffer(bytes, bitLength);
}

export function functionalBitBufferStartsWith(
  buffer: FunctionalBitBuffer,
  prefix: FunctionalBitBuffer,
): boolean {
  const normalizedBuffer = functionalBitBuffer(buffer.bytes, buffer.bitLength);
  const normalizedPrefix = functionalBitBuffer(prefix.bytes, prefix.bitLength);
  if (normalizedPrefix.bitLength > normalizedBuffer.bitLength) return false;
  for (let index = 0; index < normalizedPrefix.bitLength; index++) {
    if (bitAt(normalizedBuffer, index) !== bitAt(normalizedPrefix, index)) return false;
  }
  return true;
}

function bitAt(buffer: FunctionalBitBuffer, index: number): boolean {
  const byte = buffer.bytes[Math.floor(index / 8)]!;
  return (byte & (1 << (7 - (index % 8)))) !== 0;
}

function setBit(bytes: Uint8Array, index: number): void {
  const byteIndex = Math.floor(index / 8);
  bytes[byteIndex] = bytes[byteIndex]! | (1 << (7 - (index % 8)));
}
