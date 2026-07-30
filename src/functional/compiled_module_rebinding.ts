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
