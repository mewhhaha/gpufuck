import { CoreTag, EvaluationMode, NO_INDEX } from "./abi.ts";
import type { CompiledModule, CoreNode } from "./compiler_module.ts";
import { primopDeclaration, PrimopFamily } from "../semantic/primops.ts";

export function lowerCoreForWasm(
  module: CompiledModule,
  nodes: readonly CoreNode[],
): readonly CoreNode[] {
  const lowered = [...nodes];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex];
    if (node === undefined) {
      throw new Error(`functional Wasm lowering omitted Core node ${nodeIndex}`);
    }
    if (node.tag === CoreTag.Prim) {
      lowered[nodeIndex] = lowerPrimop(module, nodeIndex, node);
      continue;
    }
    if (node.tag === CoreTag.Lambda && node.child1 > 0) {
      lowered[nodeIndex] = lowerLambda(lowered, node);
      continue;
    }
    if (node.tag === CoreTag.Apply && node.child1 > 0) {
      lowered[nodeIndex] = lowerApplication(module, lowered, nodeIndex, node);
      continue;
    }
    if (node.tag === CoreTag.Apply && node.child1 === 0) {
      const unitConstructor = module.constructorNames.indexOf("$Unit");
      if (unitConstructor < 0) {
        throw new Error(
          `functional Wasm lowering zero-arity application ${nodeIndex} requires the built-in Unit constructor`,
        );
      }
      const argument = lowered.length;
      lowered.push({
        tag: CoreTag.Constructor,
        payload: unitConstructor,
        child0: NO_INDEX,
        child1: NO_INDEX,
        child2: NO_INDEX,
        sourceByteOffset: node.sourceByteOffset,
        sourceEndByte: node.sourceEndByte,
        evaluationMode: EvaluationMode.LazyCallByNeed,
      });
      lowered[nodeIndex] = { ...node, payload: NO_INDEX, child1: argument };
      continue;
    }
    if (
      node.tag === CoreTag.Case &&
      (node.payload > module.caseAlternatives.length ||
        node.child1 > module.caseAlternatives.length - node.payload)
    ) {
      throw new Error(
        `functional Wasm lowering case ${nodeIndex} references alternatives ${node.payload}..${
          node.payload + node.child1
        } outside ${module.caseAlternatives.length}`,
      );
    }
  }
  for (const node of lowered) {
    if (!Object.isFrozen(node)) Object.freeze(node);
  }
  return Object.freeze(lowered);
}

function lowerPrimop(
  module: CompiledModule,
  nodeIndex: number,
  primop: CoreNode,
): CoreNode {
  const declaration = primopDeclaration(primop.payload);
  if (declaration === undefined || declaration.arity !== primop.child1) {
    throw new Error(
      `functional Wasm lowering Core node ${nodeIndex} references invalid primop ${primop.payload}`,
    );
  }
  if (
    primop.child0 > module.arguments.length ||
    primop.child1 > module.arguments.length - primop.child0
  ) {
    throw new Error(
      `functional Wasm lowering primop ${declaration.name} at node ${nodeIndex} references operands ${primop.child0}..${
        primop.child0 + primop.child1
      } outside ${module.arguments.length}`,
    );
  }
  const operands = Array.from({ length: primop.child1 }, (_, offset) => {
    const operand = module.arguments[primop.child0 + offset];
    if (operand === undefined) {
      throw new Error(
        `functional Wasm lowering primop ${declaration.name} omitted operand ${offset}`,
      );
    }
    return operand.node;
  });
  const child = (index: number): number => operands[index] ?? NO_INDEX;
  const tag = declaration.family === PrimopFamily.Unary
    ? CoreTag.Unary
    : declaration.family === PrimopFamily.Binary
    ? CoreTag.Binary
    : declaration.family === PrimopFamily.NumericConversion
    ? CoreTag.NumericConvert
    : declaration.family === PrimopFamily.BufferAppend
    ? CoreTag.BufferAppend
    : declaration.family === PrimopFamily.StoreEmpty
    ? CoreTag.StoreEmpty
    : declaration.family === PrimopFamily.StoreNew
    ? CoreTag.StoreNew
    : declaration.family === PrimopFamily.StoreLength
    ? CoreTag.StoreLength
    : declaration.family === PrimopFamily.StoreRead
    ? CoreTag.StoreRead
    : declaration.family === PrimopFamily.StoreWrite
    ? CoreTag.StoreWrite
    : CoreTag.StoreGrow;
  const payload = declaration.family === PrimopFamily.Unary ||
      declaration.family === PrimopFamily.Binary ||
      declaration.family === PrimopFamily.NumericConversion
    ? declaration.operation
    : declaration.family === PrimopFamily.BufferAppend
    ? 0
    : primop.child2;
  return {
    ...primop,
    tag,
    payload,
    child0: child(0),
    child1: declaration.family === PrimopFamily.Unary ? primop.child2 : child(1),
    child2: declaration.family === PrimopFamily.Binary ||
        declaration.family === PrimopFamily.BufferAppend
      ? primop.child2
      : child(2),
  };
}

function lowerLambda(nodes: CoreNode[], lambda: CoreNode): CoreNode {
  let body = lambda.child0;
  for (let parameter = lambda.child1 - 1; parameter > 0; parameter--) {
    const innerLambda = nodes.length;
    nodes.push({
      ...lambda,
      child0: body,
      child1: NO_INDEX,
    });
    body = innerLambda;
  }
  return {
    ...lambda,
    child0: body,
    child1: NO_INDEX,
  };
}

function lowerApplication(
  module: CompiledModule,
  nodes: CoreNode[],
  nodeIndex: number,
  application: CoreNode,
): CoreNode {
  const firstArgument = application.payload;
  if (
    firstArgument === NO_INDEX ||
    firstArgument + application.child1 > module.arguments.length
  ) {
    throw new Error(
      `functional Wasm lowering application ${nodeIndex} references arguments ${firstArgument}..${
        firstArgument + application.child1
      } outside ${module.arguments.length}`,
    );
  }
  let callee = application.child0;
  for (let argumentOffset = 0; argumentOffset < application.child1 - 1; argumentOffset++) {
    const argument = module.arguments[firstArgument + argumentOffset];
    if (argument === undefined) {
      throw new Error(
        `functional Wasm lowering application ${nodeIndex} omitted argument ${
          firstArgument + argumentOffset
        }`,
      );
    }
    const partialApplication = nodes.length;
    nodes.push({
      ...application,
      payload: 0,
      child0: callee,
      child1: argument.node,
      evaluationMode: argument.evaluationMode,
    });
    callee = partialApplication;
  }
  const finalArgument = module.arguments[firstArgument + application.child1 - 1];
  if (finalArgument === undefined) {
    throw new Error(`functional Wasm lowering application ${nodeIndex} omitted its final argument`);
  }
  return {
    ...application,
    payload: 0,
    child0: callee,
    child1: finalArgument.node,
    evaluationMode: finalArgument.evaluationMode,
  };
}
