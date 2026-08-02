import {
  ARGUMENT_WORD_LENGTH,
  ArgumentWord,
  BranchLikelihood,
  CASE_ALTERNATIVE_WORD_LENGTH,
  CaseAlternativeWord,
  CoreTag,
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type EncodedModule,
  EvaluationMode,
  NO_INDEX,
  NODE_BYTE_LENGTH,
  NODE_WORD_LENGTH,
  NodeWord,
  RuntimeFaultCategory,
  type Type,
} from "./abi.ts";
import type { CoreNode } from "./compiler_module.ts";
import { primopDeclaration } from "../semantic/primops.ts";

export interface CompiledCoreArtifact {
  readonly nodes: readonly CoreNode[];
  readonly entryType: Type;
}

export function rebindCoreArtifactSource(
  module: EncodedModule,
  artifact: CompiledCoreArtifact,
): CompiledCoreArtifact {
  if (artifact.nodes.length !== module.nodeCount) {
    throw new Error(
      `cannot rebind ${artifact.nodes.length} Core nodes to source with ${module.nodeCount} nodes`,
    );
  }
  return {
    entryType: artifact.entryType,
    nodes: Object.freeze(artifact.nodes.map((node, nodeIndex) => {
      const offset = nodeIndex * NODE_WORD_LENGTH;
      return Object.freeze({
        ...node,
        sourceByteOffset: module.nodeWords[offset + NodeWord.StartByte] ?? 0,
        sourceEndByte: module.nodeWords[offset + NodeWord.EndByte] ?? 0,
      });
    })),
  };
}

export function applyCoreArtifactLiteralUpdate(
  module: EncodedModule,
  artifact: CompiledCoreArtifact,
  changedNodes: readonly number[],
): CompiledCoreArtifact {
  const rebound = rebindCoreArtifactSource(module, artifact);
  const changed = new Set(changedNodes);
  return {
    entryType: rebound.entryType,
    nodes: Object.freeze(rebound.nodes.map((node, nodeIndex) => {
      if (!changed.has(nodeIndex)) return node;
      const offset = nodeIndex * NODE_WORD_LENGTH;
      const payload = module.nodeWords[offset + NodeWord.Payload];
      const child0 = module.nodeWords[offset + NodeWord.Child0];
      if (payload === undefined || child0 === undefined) {
        throw new Error(`literal update omitted Core payload for node ${nodeIndex}`);
      }
      return Object.freeze({ ...node, payload, child0 });
    })),
  };
}

export function encodeCoreArtifact(
  module: EncodedModule,
  artifact: CompiledCoreArtifact,
): ArrayBuffer {
  validateCoreArtifact(module, artifact);
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

export function validateCoreArtifact(
  module: EncodedModule,
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
    if (node.tag === CoreTag.Lambda) {
      validateRange(
        `functional compiled Core lambda ${nodeIndex} parameters`,
        node.payload,
        node.child1,
        module.parameterWords.length,
      );
    }
    if (node.tag === CoreTag.Apply) {
      validateRange(
        `functional compiled Core application ${nodeIndex} arguments`,
        node.payload,
        node.child1,
        module.argumentCount,
      );
    }
    if (node.tag === CoreTag.Case) {
      validateRange(
        `functional compiled Core case ${nodeIndex} alternatives`,
        node.payload,
        node.child1,
        module.caseAlternativeCount,
      );
    }
    if (node.tag === CoreTag.Prim) {
      const declaration = primopDeclaration(node.payload);
      if (declaration === undefined || declaration.arity !== node.child1) {
        throw new Error(
          `functional compiled Core node ${nodeIndex} has invalid primop ${node.payload} with arity ${node.child1}`,
        );
      }
      validateRange(
        `functional compiled Core primop ${nodeIndex} operands`,
        node.child0,
        node.child1,
        module.argumentCount,
      );
    }
    if (
      node.tag === CoreTag.If &&
      node.payload !== BranchLikelihood.None &&
      node.payload !== BranchLikelihood.Consequent &&
      node.payload !== BranchLikelihood.Alternate
    ) {
      throw new Error(
        `functional compiled Core if ${nodeIndex} has unknown branch likelihood ${node.payload}`,
      );
    }
    if (
      node.tag === CoreTag.RuntimeFault &&
      node.child0 > RuntimeFaultCategory.Unreachable
    ) {
      throw new Error(
        `functional compiled Core node ${nodeIndex} has unknown runtime fault category ${node.child0}`,
      );
    }
    if (node.tag === CoreTag.Global && node.payload >= module.definitionCount) {
      throw new Error(
        `functional compiled Core node ${nodeIndex} references definition ${node.payload} outside ${module.definitionCount} definitions`,
      );
    }
    if (
      node.tag === CoreTag.Constructor &&
      node.payload >= module.constructorCount
    ) {
      throw new Error(
        `functional compiled Core node ${nodeIndex} references constructor ${node.payload} outside ${module.constructorCount} constructors`,
      );
    }
  }
  validateTrailingMetadata(module, artifact.nodes);
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

function validateTrailingMetadata(module: EncodedModule, nodes: readonly CoreNode[]): void {
  if (module.argumentWords.length !== module.argumentCount * ARGUMENT_WORD_LENGTH) {
    throw new Error(
      `functional compiled Core declares ${module.argumentCount} arguments in ${module.argumentWords.length} words`,
    );
  }
  for (let argument = 0; argument < module.argumentCount; argument++) {
    const offset = argument * ARGUMENT_WORD_LENGTH;
    const node = module.argumentWords[offset + ArgumentWord.Node];
    const evaluationMode = module.argumentWords[offset + ArgumentWord.EvaluationMode];
    if (node === undefined || node >= nodes.length) {
      throw new Error(
        `functional compiled Core argument ${argument} references node ${node} outside ${nodes.length} nodes`,
      );
    }
    if (
      evaluationMode !== EvaluationMode.LazyCallByNeed &&
      evaluationMode !== EvaluationMode.StrictEager
    ) {
      throw new Error(
        `functional compiled Core argument ${argument} has unknown evaluation mode ${evaluationMode}`,
      );
    }
  }
  if (
    module.caseAlternativeWords.length !==
      module.caseAlternativeCount * CASE_ALTERNATIVE_WORD_LENGTH
  ) {
    throw new Error(
      `functional compiled Core declares ${module.caseAlternativeCount} case alternatives in ${module.caseAlternativeWords.length} words`,
    );
  }
  for (let alternative = 0; alternative < module.caseAlternativeCount; alternative++) {
    const offset = alternative * CASE_ALTERNATIVE_WORD_LENGTH;
    const constructor = module.caseAlternativeWords[offset + CaseAlternativeWord.Constructor];
    const firstBinder = module.caseAlternativeWords[offset + CaseAlternativeWord.FirstBinder];
    const binderCount = module.caseAlternativeWords[offset + CaseAlternativeWord.BinderCount];
    const body = module.caseAlternativeWords[offset + CaseAlternativeWord.Body];
    if (constructor === undefined || constructor >= module.constructorCount) {
      throw new Error(
        `functional compiled Core case alternative ${alternative} references constructor ${constructor} outside ${module.constructorCount} constructors`,
      );
    }
    if (body === undefined || body >= nodes.length) {
      throw new Error(
        `functional compiled Core case alternative ${alternative} references body ${body} outside ${nodes.length} nodes`,
      );
    }
    validateRange(
      `functional compiled Core case alternative ${alternative} binders`,
      firstBinder ?? NO_INDEX,
      binderCount ?? NO_INDEX,
      module.caseBinderWords.length,
    );
  }
}

function validateRange(
  description: string,
  start: number,
  count: number,
  length: number,
): void {
  if (start <= length && count <= length - start) return;
  throw new Error(`${description} ${start}..${start + count} exceed ${length}`);
}

function childReferences(
  node: CoreNode,
): readonly (readonly [string, number])[] {
  switch (node.tag) {
    case CoreTag.SignedInteger64:
    case CoreTag.Float64:
    case CoreTag.Integer:
    case CoreTag.Float32:
    case CoreTag.Boolean:
    case CoreTag.Text:
    case CoreTag.Bytes:
    case CoreTag.RuntimeFault:
    case CoreTag.StoreEmpty:
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
    case CoreTag.Let:
    case CoreTag.LetRec:
    case CoreTag.Binary:
    case CoreTag.BufferAppend:
    case CoreTag.StoreNew:
    case CoreTag.StoreRead:
    case CoreTag.CaseArm:
      return [["child0", node.child0], ["child1", node.child1]];
    case CoreTag.Apply:
    case CoreTag.Case:
      return [["child0", node.child0]];
    case CoreTag.Prim:
      return [];
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
    case CoreTag.Case:
    case CoreTag.Prim:
      return true;
    default:
      return false;
  }
}
