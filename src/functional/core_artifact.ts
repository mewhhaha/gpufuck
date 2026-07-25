import {
  CoreTag,
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type EncodedFunctionalModule,
  EvaluationMode,
  NO_INDEX,
  NODE_BYTE_LENGTH,
  type Type,
} from "./abi.ts";
import type { CoreNode } from "./compiler_module.ts";

export interface CompiledCoreArtifact {
  readonly nodes: readonly CoreNode[];
  readonly entryType: Type;
}

export function encodeCoreArtifact(
  module: EncodedFunctionalModule,
  artifact: CompiledCoreArtifact,
): ArrayBuffer {
  validateFunctionalCoreArtifact(module, artifact);
  const bytes = new ArrayBuffer(
    Math.max(NODE_BYTE_LENGTH, artifact.nodes.length * NODE_BYTE_LENGTH),
  );
  const view = new DataView(bytes);
  for (const [nodeIndex, node] of artifact.nodes.entries()) {
    const offset = nodeIndex * NODE_BYTE_LENGTH;
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
  artifact: CompiledCoreArtifact,
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
      node.evaluationMode !== EvaluationMode.LazyCallByNeed &&
      node.evaluationMode !== EvaluationMode.StrictEager
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
      if (child === NO_INDEX || child < module.nodeCount) continue;
      throw new Error(
        `functional compiled Core node ${nodeIndex} ${childName} references node ${child} outside ${module.nodeCount} nodes`,
      );
    }
    if (node.tag === CoreTag.Global && node.payload >= module.definitionCount) {
      throw new Error(
        `functional compiled Core node ${nodeIndex} references definition ${node.payload} outside ${module.definitionCount} definitions`,
      );
    }
    if (
      (node.tag === CoreTag.Constructor || node.tag === CoreTag.CaseArm) &&
      node.payload >= module.constructorCount
    ) {
      throw new Error(
        `functional compiled Core node ${nodeIndex} references constructor ${node.payload} outside ${module.constructorCount} constructors`,
      );
    }
  }
  for (let definitionIndex = 0; definitionIndex < module.definitionCount; definitionIndex++) {
    const root = module.definitionWords[
      definitionIndex * DEFINITION_WORD_LENGTH + DefinitionWord.RootNode
    ];
    if (root !== undefined && root < module.nodeCount) continue;
    throw new Error(
      `functional compiled Core definition ${definitionIndex} references root ${root} outside ${module.nodeCount} nodes`,
    );
  }
}

function childReferences(
  node: CoreNode,
): readonly (readonly [string, number])[] {
  switch (node.tag) {
    case CoreTag.SignedInteger64:
    case CoreTag.Float64:
    case CoreTag.WholeNumberF64:
    case CoreTag.Integer:
    case CoreTag.Float32:
    case CoreTag.Boolean:
    case CoreTag.Text:
    case CoreTag.Bytes:
    case CoreTag.RuntimeFault:
    case CoreTag.Local:
    case CoreTag.Global:
    case CoreTag.Constructor:
      return [];
    case CoreTag.Lambda:
    case CoreTag.Unary:
    case CoreTag.NumericConvert:
    case CoreTag.StoreLength:
    case CoreTag.PatternBind:
      return [["child0", node.child0]];
    case CoreTag.Apply:
    case CoreTag.Let:
    case CoreTag.LetRec:
    case CoreTag.Binary:
    case CoreTag.BufferAppend:
    case CoreTag.StoreNew:
    case CoreTag.StoreRead:
    case CoreTag.Case:
    case CoreTag.CaseArm:
      return [["child0", node.child0], ["child1", node.child1]];
    case CoreTag.If:
    case CoreTag.StoreWrite:
    case CoreTag.StoreGrow:
      return [["child0", node.child0], ["child1", node.child1], ["child2", node.child2]];
  }
}

function isCoreTag(tag: number): boolean {
  switch (tag) {
    case CoreTag.Integer:
    case CoreTag.SignedInteger64:
    case CoreTag.Float32:
    case CoreTag.Float64:
    case CoreTag.WholeNumberF64:
    case CoreTag.Boolean:
    case CoreTag.Text:
    case CoreTag.Bytes:
    case CoreTag.RuntimeFault:
    case CoreTag.Local:
    case CoreTag.Global:
    case CoreTag.Constructor:
    case CoreTag.Lambda:
    case CoreTag.Apply:
    case CoreTag.Let:
    case CoreTag.LetRec:
    case CoreTag.If:
    case CoreTag.Unary:
    case CoreTag.Binary:
    case CoreTag.BufferAppend:
    case CoreTag.StoreNew:
    case CoreTag.StoreLength:
    case CoreTag.StoreRead:
    case CoreTag.StoreWrite:
    case CoreTag.StoreGrow:
    case CoreTag.NumericConvert:
    case CoreTag.Case:
    case CoreTag.CaseArm:
    case CoreTag.PatternBind:
      return true;
    default:
      return false;
  }
}
