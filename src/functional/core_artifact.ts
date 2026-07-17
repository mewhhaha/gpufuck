import {
  type EncodedFunctionalModule,
  FUNCTIONAL_DEFINITION_WORD_LENGTH,
  FUNCTIONAL_NO_INDEX,
  FUNCTIONAL_NODE_BYTE_LENGTH,
  FunctionalCoreTag,
  FunctionalDefinitionWord,
  FunctionalEvaluationMode,
  type FunctionalType,
} from "./abi.ts";
import type { FunctionalCoreNode } from "./compiler_module.ts";

export interface FunctionalCompiledCoreArtifact {
  readonly nodes: readonly FunctionalCoreNode[];
  readonly entryType: FunctionalType;
}

export function encodeFunctionalCoreArtifact(
  module: EncodedFunctionalModule,
  artifact: FunctionalCompiledCoreArtifact,
): ArrayBuffer {
  validateFunctionalCoreArtifact(module, artifact);
  const bytes = new ArrayBuffer(
    Math.max(FUNCTIONAL_NODE_BYTE_LENGTH, artifact.nodes.length * FUNCTIONAL_NODE_BYTE_LENGTH),
  );
  const view = new DataView(bytes);
  for (const [nodeIndex, node] of artifact.nodes.entries()) {
    const offset = nodeIndex * FUNCTIONAL_NODE_BYTE_LENGTH;
    view.setUint32(offset, node.tag, true);
    view.setUint32(offset + 4, node.payload, true);
    view.setUint32(offset + 8, node.child0, true);
    view.setUint32(offset + 12, node.child1, true);
    view.setUint32(offset + 16, node.child2, true);
    view.setUint32(offset + 20, node.sourceByteOffset, true);
    view.setUint32(offset + 24, node.sourceEndByte, true);
    view.setUint32(offset + 28, node.evaluationMode, true);
  }
  return bytes;
}

export function validateFunctionalCoreArtifact(
  module: EncodedFunctionalModule,
  artifact: FunctionalCompiledCoreArtifact,
): void {
  if (artifact.nodes.length !== module.nodeCount) {
    throw new Error(
      `functional compiled Core contains ${artifact.nodes.length} nodes; linked module declares ${module.nodeCount}`,
    );
  }
  for (const [nodeIndex, node] of artifact.nodes.entries()) {
    if (!isCoreTag(node.tag)) {
      throw new Error(`functional compiled Core node ${nodeIndex} has unknown tag ${node.tag}`);
    }
    if (
      node.evaluationMode !== FunctionalEvaluationMode.LazyCallByNeed &&
      node.evaluationMode !== FunctionalEvaluationMode.StrictEager
    ) {
      throw new Error(
        `functional compiled Core node ${nodeIndex} has unknown evaluation mode ${node.evaluationMode}`,
      );
    }
    if (
      node.sourceByteOffset > node.sourceEndByte ||
      node.sourceEndByte > module.sourceByteLength
    ) {
      throw new Error(
        `functional compiled Core node ${nodeIndex} has source span ${node.sourceByteOffset}..${node.sourceEndByte} outside 0..${module.sourceByteLength}`,
      );
    }
    for (const [childName, child] of childReferences(node)) {
      if (child === FUNCTIONAL_NO_INDEX || child < module.nodeCount) continue;
      throw new Error(
        `functional compiled Core node ${nodeIndex} ${childName} references node ${child} outside ${module.nodeCount} nodes`,
      );
    }
    if (node.tag === FunctionalCoreTag.Global && node.payload >= module.definitionCount) {
      throw new Error(
        `functional compiled Core node ${nodeIndex} references definition ${node.payload} outside ${module.definitionCount} definitions`,
      );
    }
    if (
      (node.tag === FunctionalCoreTag.Constructor || node.tag === FunctionalCoreTag.CaseArm) &&
      node.payload >= module.constructorCount
    ) {
      throw new Error(
        `functional compiled Core node ${nodeIndex} references constructor ${node.payload} outside ${module.constructorCount} constructors`,
      );
    }
  }
  for (let definitionIndex = 0; definitionIndex < module.definitionCount; definitionIndex++) {
    const root = module.definitionWords[
      definitionIndex * FUNCTIONAL_DEFINITION_WORD_LENGTH + FunctionalDefinitionWord.RootNode
    ];
    if (root !== undefined && root < module.nodeCount) continue;
    throw new Error(
      `functional compiled Core definition ${definitionIndex} references root ${root} outside ${module.nodeCount} nodes`,
    );
  }
}

function childReferences(
  node: FunctionalCoreNode,
): readonly (readonly [string, number])[] {
  switch (node.tag) {
    case FunctionalCoreTag.SignedInteger64:
    case FunctionalCoreTag.Float64:
    case FunctionalCoreTag.Integer:
    case FunctionalCoreTag.Float32:
    case FunctionalCoreTag.Boolean:
    case FunctionalCoreTag.Local:
    case FunctionalCoreTag.Global:
    case FunctionalCoreTag.Constructor:
      return [];
    case FunctionalCoreTag.Lambda:
    case FunctionalCoreTag.Unary:
    case FunctionalCoreTag.NumericConvert:
    case FunctionalCoreTag.PatternBind:
      return [["child0", node.child0]];
    case FunctionalCoreTag.Apply:
    case FunctionalCoreTag.Let:
    case FunctionalCoreTag.LetRec:
    case FunctionalCoreTag.Binary:
    case FunctionalCoreTag.Case:
    case FunctionalCoreTag.CaseArm:
      return [["child0", node.child0], ["child1", node.child1]];
    case FunctionalCoreTag.If:
      return [["child0", node.child0], ["child1", node.child1], ["child2", node.child2]];
  }
}

function isCoreTag(tag: number): boolean {
  switch (tag) {
    case FunctionalCoreTag.Integer:
    case FunctionalCoreTag.SignedInteger64:
    case FunctionalCoreTag.Float32:
    case FunctionalCoreTag.Float64:
    case FunctionalCoreTag.Boolean:
    case FunctionalCoreTag.Local:
    case FunctionalCoreTag.Global:
    case FunctionalCoreTag.Constructor:
    case FunctionalCoreTag.Lambda:
    case FunctionalCoreTag.Apply:
    case FunctionalCoreTag.Let:
    case FunctionalCoreTag.LetRec:
    case FunctionalCoreTag.If:
    case FunctionalCoreTag.Unary:
    case FunctionalCoreTag.Binary:
    case FunctionalCoreTag.NumericConvert:
    case FunctionalCoreTag.Case:
    case FunctionalCoreTag.CaseArm:
    case FunctionalCoreTag.PatternBind:
      return true;
    default:
      return false;
  }
}
