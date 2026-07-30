import { type EncodedModule, ExpressionTag, NODE_WORD_LENGTH, NodeWord } from "./abi.ts";

export interface LiteralModuleUpdate {
  readonly reference: EncodedModule;
  readonly changedNodes: readonly number[];
}

const literalUpdates = new WeakMap<EncodedModule, LiteralModuleUpdate>();

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
    case ExpressionTag.WholeNumberF64:
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
    left.evaluationProfile === right.evaluationProfile &&
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

function sameWords(left: Uint32Array, right: Uint32Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((word, index) => word === right[index]);
}
