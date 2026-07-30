import {
  CASE_ALTERNATIVE_WORD_LENGTH,
  CaseAlternativeWord,
  type EncodedModule,
  NODE_WORD_LENGTH,
  NodeWord,
} from "./abi.ts";
import {
  type CompiledModule,
  completeTypeDeclarations,
  registerCompleteTypeDeclarations,
} from "./compiler_module.ts";
import type { LiteralModuleUpdate } from "./incremental_module.ts";
import { registerEquivalentResolvedCoreFingerprint } from "./semantic_fingerprint.ts";

export async function rebindCompiledModuleSource(
  compiled: CompiledModule,
  source: EncodedModule,
): Promise<CompiledModule> {
  if (
    compiled.nodeCount !== source.nodeCount ||
    compiled.definitionCount !== source.definitionCount ||
    compiled.constructorCount !== source.constructorCount
  ) {
    throw new Error(
      `cannot rebind ${compiled.nodeCount} Core nodes to source with ${source.nodeCount} nodes`,
    );
  }
  const previousNodes = await compiled.readCoreNodes();
  const nodes = Object.freeze(previousNodes.map((node, nodeIndex) => {
    const offset = nodeIndex * NODE_WORD_LENGTH;
    return Object.freeze({
      ...node,
      sourceByteOffset: source.nodeWords[offset + NodeWord.StartByte] ?? 0,
      sourceEndByte: source.nodeWords[offset + NodeWord.EndByte] ?? 0,
    });
  }));
  const caseAlternatives = Object.freeze(
    compiled.caseAlternatives.map((alternative, alternativeIndex) => {
      const offset = alternativeIndex * CASE_ALTERNATIVE_WORD_LENGTH;
      return Object.freeze({
        ...alternative,
        sourceByteOffset: source.caseAlternativeWords[offset + CaseAlternativeWord.StartByte] ?? 0,
        sourceEndByte: source.caseAlternativeWords[offset + CaseAlternativeWord.EndByte] ?? 0,
      });
    }),
  );
  const rebound: CompiledModule = Object.freeze({
    ...compiled,
    caseAlternatives,
    sources: Object.freeze([...(source.sources ?? [])]),
    readCoreNodes: () => Promise.resolve(nodes),
    destroy: () => {},
  });
  registerCompleteTypeDeclarations(rebound, completeTypeDeclarations(compiled));
  registerEquivalentResolvedCoreFingerprint(compiled, rebound);
  return rebound;
}

export async function applyCompiledLiteralUpdate(
  compiled: CompiledModule,
  source: EncodedModule,
  update: LiteralModuleUpdate,
): Promise<CompiledModule> {
  if (compiled.nodeCount !== source.nodeCount) {
    throw new Error(
      `cannot apply ${update.changedNodes.length} literal updates to ${compiled.nodeCount} Core nodes from source with ${source.nodeCount} nodes`,
    );
  }
  const changedNodes = new Set(update.changedNodes);
  const previousNodes = await compiled.readCoreNodes();
  const nodes = Object.freeze(previousNodes.map((node, nodeIndex) => {
    if (!changedNodes.has(nodeIndex)) return node;
    const payload = source.nodeWords[nodeIndex * NODE_WORD_LENGTH + NodeWord.Payload];
    if (payload === undefined) {
      throw new Error(`literal update omitted payload for Core node ${nodeIndex}`);
    }
    const child0 = source.nodeWords[nodeIndex * NODE_WORD_LENGTH + NodeWord.Child0];
    if (child0 === undefined) {
      throw new Error(`literal update omitted child0 for Core node ${nodeIndex}`);
    }
    return Object.freeze({ ...node, payload, child0 });
  }));
  const updated: CompiledModule = Object.freeze({
    ...compiled,
    sources: Object.freeze([...(source.sources ?? [])]),
    readCoreNodes: () => Promise.resolve(nodes),
    destroy: () => {},
  });
  registerCompleteTypeDeclarations(updated, completeTypeDeclarations(compiled));
  return updated;
}
