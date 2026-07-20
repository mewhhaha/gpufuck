import { FunctionalBinaryOperator, FunctionalCoreTag, FunctionalUnaryOperator } from "./abi.ts";
import type { FunctionalCoreNode } from "./compiler_module.ts";
import { isComparisonOperator } from "./wasm_numeric.ts";

const MAXIMUM_CONSTANT_PROOF_TRANSITIONS = 4_096;

export type FunctionalScalarConstant =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean };

export type FunctionalConstantResolver = (
  localDepth: number,
) => FunctionalScalarConstant | undefined;

export type FunctionalConstantEnvironment =
  | readonly (FunctionalScalarConstant | undefined)[]
  | FunctionalConstantResolver;

export class FunctionalWasmConstantAnalysis {
  readonly #nodes: readonly FunctionalCoreNode[];

  constructor(nodes: readonly FunctionalCoreNode[]) {
    this.#nodes = nodes;
  }

  scalar(
    nodeIndex: number,
    environment: FunctionalConstantEnvironment = [],
  ): FunctionalScalarConstant | undefined {
    return this.#scalar(nodeIndex, environment, true, constantProof());
  }

  #scalar(
    nodeIndex: number,
    environment: FunctionalConstantEnvironment,
    allowLocalBindings: boolean,
    proof: FunctionalConstantProof,
  ): FunctionalScalarConstant | undefined {
    const integer = this.#integer(nodeIndex, environment, allowLocalBindings, proof);
    if (integer !== undefined) return { kind: "integer", value: integer };
    const boolean = this.#boolean(nodeIndex, environment, allowLocalBindings, proof);
    return boolean === undefined ? undefined : { kind: "boolean", value: boolean };
  }

  integer(
    nodeIndex: number,
    environment: FunctionalConstantEnvironment = [],
  ): number | undefined {
    return this.#integer(nodeIndex, environment, true, constantProof());
  }

  integerWithoutLocalBindings(
    nodeIndex: number,
    environment: FunctionalConstantEnvironment = [],
  ): number | undefined {
    return this.#integer(nodeIndex, environment, false, constantProof());
  }

  #integer(
    nodeIndex: number,
    environment: FunctionalConstantEnvironment,
    allowLocalBindings: boolean,
    proof: FunctionalConstantProof,
  ): number | undefined {
    if (!advanceConstantProof(proof)) return undefined;
    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
        return node.payload | 0;
      case FunctionalCoreTag.Local: {
        const constant = constantAt(environment, node.payload);
        return constant?.kind === "integer" ? constant.value : undefined;
      }
      case FunctionalCoreTag.Unary: {
        if (node.payload !== FunctionalUnaryOperator.Negate) return undefined;
        const operand = this.#integer(node.child0, environment, allowLocalBindings, proof);
        return operand === undefined ? undefined : Math.imul(operand, -1);
      }
      case FunctionalCoreTag.Binary:
        return this.#integerBinary(node, environment, allowLocalBindings, proof);
      case FunctionalCoreTag.If: {
        const condition = this.#boolean(node.child0, environment, allowLocalBindings, proof);
        if (condition === undefined) return undefined;
        return this.#integer(
          condition ? node.child1 : node.child2,
          environment,
          allowLocalBindings,
          proof,
        );
      }
      case FunctionalCoreTag.Let: {
        if (!allowLocalBindings) return undefined;
        const value = this.#scalar(node.child0, environment, true, proof);
        if (value === undefined) return undefined;
        return this.#integer(
          node.child1,
          extendConstantEnvironment(value, environment),
          true,
          proof,
        );
      }
      default:
        return undefined;
    }
  }

  boolean(
    nodeIndex: number,
    environment: FunctionalConstantEnvironment = [],
  ): boolean | undefined {
    return this.#boolean(nodeIndex, environment, true, constantProof());
  }

  booleanWithoutLocalBindings(
    nodeIndex: number,
    environment: FunctionalConstantEnvironment = [],
  ): boolean | undefined {
    return this.#boolean(nodeIndex, environment, false, constantProof());
  }

  #boolean(
    nodeIndex: number,
    environment: FunctionalConstantEnvironment,
    allowLocalBindings: boolean,
    proof: FunctionalConstantProof,
  ): boolean | undefined {
    if (!advanceConstantProof(proof)) return undefined;
    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Boolean:
        return node.payload !== 0;
      case FunctionalCoreTag.Local: {
        const constant = constantAt(environment, node.payload);
        return constant?.kind === "boolean" ? constant.value : undefined;
      }
      case FunctionalCoreTag.Binary:
        return this.#integerComparison(node, environment, allowLocalBindings, proof);
      case FunctionalCoreTag.If: {
        const condition = this.#boolean(node.child0, environment, allowLocalBindings, proof);
        if (condition === undefined) return undefined;
        return this.#boolean(
          condition ? node.child1 : node.child2,
          environment,
          allowLocalBindings,
          proof,
        );
      }
      case FunctionalCoreTag.Let: {
        if (!allowLocalBindings) return undefined;
        const value = this.#scalar(node.child0, environment, true, proof);
        if (value === undefined) return undefined;
        return this.#boolean(
          node.child1,
          extendConstantEnvironment(value, environment),
          true,
          proof,
        );
      }
      default:
        return undefined;
    }
  }

  #integerBinary(
    node: FunctionalCoreNode,
    environment: FunctionalConstantEnvironment,
    allowLocalBindings: boolean,
    proof: FunctionalConstantProof,
  ): number | undefined {
    if (isComparisonOperator(node.payload)) return undefined;
    const left = this.#integer(node.child0, environment, allowLocalBindings, proof);
    if (left === undefined) return undefined;
    const right = this.#integer(node.child1, environment, allowLocalBindings, proof);
    if (right === undefined) return undefined;
    if (node.payload === FunctionalBinaryOperator.Add) return (left + right) | 0;
    if (node.payload === FunctionalBinaryOperator.Subtract) return (left - right) | 0;
    if (node.payload === FunctionalBinaryOperator.Multiply) return Math.imul(left, right);
    if (node.payload === FunctionalBinaryOperator.Divide && right !== 0) {
      return Math.trunc(left / right) | 0;
    }
    if (node.payload === FunctionalBinaryOperator.Remainder && right !== 0) {
      return (left % right) | 0;
    }
    if (node.payload === FunctionalBinaryOperator.BitwiseAnd) return left & right;
    if (node.payload === FunctionalBinaryOperator.BitwiseOr) return left | right;
    if (node.payload === FunctionalBinaryOperator.BitwiseXor) return left ^ right;
    if (node.payload === FunctionalBinaryOperator.ShiftLeft) return left << right;
    if (node.payload === FunctionalBinaryOperator.ShiftRightUnsigned) return (left >>> right) | 0;
    return undefined;
  }

  #integerComparison(
    node: FunctionalCoreNode,
    environment: FunctionalConstantEnvironment,
    allowLocalBindings: boolean,
    proof: FunctionalConstantProof,
  ): boolean | undefined {
    if (!isComparisonOperator(node.payload)) return undefined;
    const left = this.#integer(node.child0, environment, allowLocalBindings, proof);
    if (left === undefined) return undefined;
    const right = this.#integer(node.child1, environment, allowLocalBindings, proof);
    if (right === undefined) return undefined;
    if (node.payload === FunctionalBinaryOperator.Equal) return left === right;
    if (node.payload === FunctionalBinaryOperator.NotEqual) return left !== right;
    if (node.payload === FunctionalBinaryOperator.Less) return left < right;
    if (node.payload === FunctionalBinaryOperator.LessEqual) return left <= right;
    if (node.payload === FunctionalBinaryOperator.Greater) return left > right;
    if (node.payload === FunctionalBinaryOperator.GreaterEqual) return left >= right;
    return undefined;
  }

  #node(nodeIndex: number): FunctionalCoreNode {
    const node = this.#nodes[nodeIndex];
    if (node === undefined) {
      throw new Error(
        `functional WASM constant analysis references missing core node ${nodeIndex} of ${this.#nodes.length}`,
      );
    }
    return node;
  }
}

interface FunctionalConstantProof {
  remainingTransitions: number;
}

function constantProof(): FunctionalConstantProof {
  return { remainingTransitions: MAXIMUM_CONSTANT_PROOF_TRANSITIONS };
}

function advanceConstantProof(proof: FunctionalConstantProof): boolean {
  if (proof.remainingTransitions === 0) return false;
  proof.remainingTransitions -= 1;
  return true;
}

function constantAt(
  environment: FunctionalConstantEnvironment,
  localDepth: number,
): FunctionalScalarConstant | undefined {
  return typeof environment === "function" ? environment(localDepth) : environment[localDepth];
}

function extendConstantEnvironment(
  value: FunctionalScalarConstant,
  environment: FunctionalConstantEnvironment,
): FunctionalConstantResolver {
  return (localDepth) => localDepth === 0 ? value : constantAt(environment, localDepth - 1);
}
