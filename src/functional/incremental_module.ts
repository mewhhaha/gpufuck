import { type EncodedModule, ExpressionTag, NODE_WORD_LENGTH, NodeWord } from "./abi.ts";
import type { LinkedModule, ModuleArtifact } from "./module_linker.ts";

export interface LiteralModuleUpdate {
  readonly reference: EncodedModule;
  readonly changedNodes: readonly number[];
}

const literalUpdates = new WeakMap<EncodedModule, LiteralModuleUpdate>();

export interface LinkedLiteralModuleUpdate {
  readonly linked: LinkedModule;
  readonly changedNodes: number;
}

interface SignedIntegerLiteralChange {
  readonly module: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly value: bigint;
}

export function tryApplyLinkedLiteralUpdates(
  reference: LinkedModule,
  previousArtifacts: readonly ModuleArtifact[],
  updatedArtifacts: readonly ModuleArtifact[],
): LinkedLiteralModuleUpdate | undefined {
  if (previousArtifacts.length !== updatedArtifacts.length) return undefined;
  const changes: SignedIntegerLiteralChange[] = [];
  for (let index = 0; index < previousArtifacts.length; index++) {
    const previous = previousArtifacts[index]!;
    const updated = updatedArtifacts[index]!;
    if (previous.name !== updated.name || previous.sourceByteLength !== updated.sourceByteLength) {
      return undefined;
    }
    if (!sameArtifactValue(previous, updated, previous.name, changes)) return undefined;
  }
  if (changes.length === 0) return undefined;

  const nodeWords = reference.module.nodeWords.slice();
  const changedNodes: number[] = [];
  for (const change of changes) {
    const source = reference.sources.find((candidate) => candidate.module === change.module);
    if (source === undefined) return undefined;
    const startByte = source.startByte + change.startByte;
    const endByte = source.startByte + change.endByte;
    let changedNode: number | undefined;
    for (let nodeIndex = 0; nodeIndex < reference.module.nodeCount; nodeIndex++) {
      const offset = nodeIndex * NODE_WORD_LENGTH;
      if (
        nodeWords[offset + NodeWord.Tag] !== ExpressionTag.SignedInteger64 ||
        nodeWords[offset + NodeWord.StartByte] !== startByte ||
        nodeWords[offset + NodeWord.EndByte] !== endByte
      ) {
        continue;
      }
      if (changedNode !== undefined) return undefined;
      changedNode = nodeIndex;
    }
    if (changedNode === undefined) return undefined;
    if (changedNodes.includes(changedNode)) return undefined;
    const bits = BigInt.asUintN(64, change.value);
    const offset = changedNode * NODE_WORD_LENGTH;
    nodeWords[offset + NodeWord.Payload] = Number(bits & 0xffffffffn);
    nodeWords[offset + NodeWord.Child0] = Number(bits >> 32n);
    changedNodes.push(changedNode);
  }

  const module = Object.freeze({ ...reference.module, nodeWords });
  if (!tryRegisterLiteralModuleUpdate(reference.module, module)) return undefined;
  return {
    linked: Object.freeze({ module, sources: reference.sources }),
    changedNodes: changedNodes.length,
  };
}

export function tryRegisterLiteralModuleUpdate(
  reference: EncodedModule,
  updated: EncodedModule,
): boolean {
  if (reference.nodeCount !== updated.nodeCount) return false;
  if (!sameModuleMetadata(reference, updated)) return false;
  if (
    !sameWords(reference.parameterWords, updated.parameterWords) ||
    !sameWords(reference.argumentWords, updated.argumentWords) ||
    !sameWords(reference.caseAlternativeWords, updated.caseAlternativeWords) ||
    !sameWords(reference.caseBinderWords, updated.caseBinderWords) ||
    !sameWords(reference.definitionWords, updated.definitionWords) ||
    !sameWords(reference.typeWords, updated.typeWords) ||
    !sameWords(reference.constructorWords, updated.constructorWords)
  ) {
    return false;
  }

  const changedNodes: number[] = [];
  for (let nodeIndex = 0; nodeIndex < reference.nodeCount; nodeIndex++) {
    const offset = nodeIndex * NODE_WORD_LENGTH;
    let payloadChanged = false;
    for (let word = 0; word < NODE_WORD_LENGTH; word++) {
      if (reference.nodeWords[offset + word] === updated.nodeWords[offset + word]) continue;
      const referenceTag = reference.nodeWords[offset + NodeWord.Tag];
      const updatedTag = updated.nodeWords[offset + NodeWord.Tag];
      if (referenceTag !== updatedTag || !isLiteralPayloadWord(referenceTag, word)) {
        return false;
      }
      payloadChanged = true;
    }
    if (payloadChanged) changedNodes.push(nodeIndex);
  }
  if (changedNodes.length === 0) return false;
  literalUpdates.set(updated, {
    reference,
    changedNodes: Object.freeze(changedNodes),
  });
  return true;
}

function isLiteralPayloadWord(tag: number | undefined, word: number): boolean {
  switch (tag) {
    case ExpressionTag.Integer:
    case ExpressionTag.Boolean:
    case ExpressionTag.Float32:
      return word === NodeWord.Payload;
    case ExpressionTag.SignedInteger64:
    case ExpressionTag.Float64:
      return word === NodeWord.Payload || word === NodeWord.Child0;
    default:
      return false;
  }
}

export function literalModuleUpdate(module: EncodedModule): LiteralModuleUpdate | undefined {
  return literalUpdates.get(module);
}

function sameModuleMetadata(left: EncodedModule, right: EncodedModule): boolean {
  return left.abiVersion === right.abiVersion &&
    left.sourceByteLength === right.sourceByteLength &&
    left.typecheckingProfile === right.typecheckingProfile &&
    left.nodeCount === right.nodeCount &&
    left.argumentCount === right.argumentCount &&
    left.caseAlternativeCount === right.caseAlternativeCount &&
    left.definitionCount === right.definitionCount &&
    left.typeCount === right.typeCount &&
    left.constructorCount === right.constructorCount &&
    left.entrySymbol === right.entrySymbol &&
    sameMetadataValue(left.primitiveCapabilities, right.primitiveCapabilities) &&
    sameMetadataValue(left.hostCapabilities, right.hostCapabilities) &&
    sameMetadataValue(left.hostDefinitions, right.hostDefinitions) &&
    sameMetadataValue(left.declaredDefinitionEffects, right.declaredDefinitionEffects) &&
    sameMetadataValue(left.wasmExports, right.wasmExports) &&
    sameMetadataValue(left.sources, right.sources) &&
    sameMetadataValue(left.symbolNames, right.symbolNames) &&
    sameMetadataValue(left.definitionTypes, right.definitionTypes) &&
    sameMetadataValue(left.typeDeclarations, right.typeDeclarations);
}

function sameMetadataValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Set && right instanceof Set) {
    return left.size === right.size && [...left].every((member) => right.has(member));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((member, index) => sameMetadataValue(member, right[index]));
  }
  if (
    left === null || right === null ||
    typeof left !== "object" || typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length &&
    keys.every((key) =>
      Object.hasOwn(rightRecord, key) &&
      sameMetadataValue(leftRecord[key], rightRecord[key])
    );
}

function sameArtifactValue(
  left: unknown,
  right: unknown,
  module: string,
  changes: SignedIntegerLiteralChange[],
): boolean {
  if (left === right) return true;
  if (isSignedIntegerLiteral(left) && isSignedIntegerLiteral(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (
      leftKeys.length !== rightKeys.length ||
      !leftKeys.every((key) => Object.hasOwn(right, key))
    ) return false;
    for (const key of leftKeys) {
      if (key === "value") continue;
      if (
        !sameArtifactValue(
          (left as Readonly<Record<string, unknown>>)[key],
          (right as Readonly<Record<string, unknown>>)[key],
          module,
          changes,
        )
      ) return false;
    }
    if (left.value !== right.value) {
      if (left.span === undefined || right.span === undefined) return false;
      changes.push({
        module,
        startByte: right.span.startByte,
        endByte: right.span.endByte,
        value: right.value,
      });
    }
    return true;
  }
  if (left instanceof Set && right instanceof Set) {
    return left.size === right.size && [...left].every((member) => right.has(member));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((member, index) => sameArtifactValue(member, right[index], module, changes));
  }
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  }
  if (
    left === null || right === null ||
    typeof left !== "object" || typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length &&
    keys.every((key) =>
      Object.hasOwn(rightRecord, key) &&
      sameArtifactValue(leftRecord[key], rightRecord[key], module, changes)
    );
}

function isSignedIntegerLiteral(
  value: unknown,
): value is {
  readonly kind: "signed-integer-64";
  readonly value: bigint;
  readonly span?: { readonly startByte: number; readonly endByte: number };
} {
  return value !== null && typeof value === "object" &&
    (value as { readonly kind?: unknown }).kind === "signed-integer-64" &&
    typeof (value as { readonly value?: unknown }).value === "bigint";
}

function sameWords(left: Uint32Array, right: Uint32Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((word, index) => word === right[index]);
}
