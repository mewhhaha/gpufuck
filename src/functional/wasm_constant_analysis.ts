import { BinaryOperator, CoreTag, UnaryOperator } from "./abi.ts";
import type { CoreNode } from "./compiler_module.ts";
import { isComparisonOperator } from "./wasm_numeric.ts";

const MAXIMUM_CONSTANT_PROOF_TRANSITIONS = 4_096;

export type ScalarConstant =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean };

export type ConstantResolver = (
  localDepth: number,
) => ScalarConstant | undefined;

export type ConstantEnvironment =
  | readonly (ScalarConstant | undefined)[]
  | ConstantResolver;

export class WasmConstantAnalysis {
  readonly #nodes: readonly CoreNode[];

  constructor(nodes: readonly CoreNode[]) {
    this.#nodes = nodes;
  }

  scalar(
    nodeIndex: number,
    environment: ConstantEnvironment = [],
  ): ScalarConstant | undefined {
    return this.#scalar(nodeIndex, environment, true, constantProof());
  }

  #scalar(
    nodeIndex: number,
    environment: ConstantEnvironment,
    allowLocalBindings: boolean,
    proof: ConstantProof,
  ): ScalarConstant | undefined {
    const integer = this.#integer(nodeIndex, environment, allowLocalBindings, proof);
    if (integer !== undefined) return { kind: "integer", value: integer };
    const boolean = this.#boolean(nodeIndex, environment, allowLocalBindings, proof);
    return boolean === undefined ? undefined : { kind: "boolean", value: boolean };
  }

  integer(
    nodeIndex: number,
    environment: ConstantEnvironment = [],
  ): number | undefined {
    return this.#integer(nodeIndex, environment, true, constantProof());
  }

  integerWithoutLocalBindings(
    nodeIndex: number,
    environment: ConstantEnvironment = [],
  ): number | undefined {
    return this.#integer(nodeIndex, environment, false, constantProof());
  }

  #integer(
    nodeIndex: number,
    environment: ConstantEnvironment,
    allowLocalBindings: boolean,
    proof: ConstantProof,
  ): number | undefined {
    if (!advanceConstantProof(proof)) return undefined;
    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Integer:
        return node.payload | 0;
      case CoreTag.Local: {
        const constant = constantAt(environment, node.payload);
        return constant?.kind === "integer" ? constant.value : undefined;
      }
      case CoreTag.Unary: {
        if (node.payload !== UnaryOperator.Negate) return undefined;
        const operand = this.#integer(node.child0, environment, allowLocalBindings, proof);
        return operand === undefined ? undefined : Math.imul(operand, -1);
      }
      case CoreTag.Binary:
        return this.#integerBinary(node, environment, allowLocalBindings, proof);
      case CoreTag.If: {
        const condition = this.#boolean(node.child0, environment, allowLocalBindings, proof);
        if (condition === undefined) return undefined;
        return this.#integer(
          condition ? node.child1 : node.child2,
          environment,
          allowLocalBindings,
          proof,
        );
      }
      case CoreTag.Let: {
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
    environment: ConstantEnvironment = [],
  ): boolean | undefined {
    return this.#boolean(nodeIndex, environment, true, constantProof());
  }

  booleanWithoutLocalBindings(
    nodeIndex: number,
    environment: ConstantEnvironment = [],
  ): boolean | undefined {
    return this.#boolean(nodeIndex, environment, false, constantProof());
  }

  #boolean(
    nodeIndex: number,
    environment: ConstantEnvironment,
    allowLocalBindings: boolean,
    proof: ConstantProof,
  ): boolean | undefined {
    if (!advanceConstantProof(proof)) return undefined;
    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Boolean:
        return node.payload !== 0;
      case CoreTag.Local: {
        const constant = constantAt(environment, node.payload);
        return constant?.kind === "boolean" ? constant.value : undefined;
      }
      case CoreTag.Binary:
        return this.#integerComparison(node, environment, allowLocalBindings, proof);
      case CoreTag.If: {
        const condition = this.#boolean(node.child0, environment, allowLocalBindings, proof);
        if (condition === undefined) return undefined;
        return this.#boolean(
          condition ? node.child1 : node.child2,
          environment,
          allowLocalBindings,
          proof,
        );
      }
      case CoreTag.Let: {
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
    node: CoreNode,
    environment: ConstantEnvironment,
    allowLocalBindings: boolean,
    proof: ConstantProof,
  ): number | undefined {
    if (isComparisonOperator(node.payload)) return undefined;
    const left = this.#integer(node.child0, environment, allowLocalBindings, proof);
    if (left === undefined) return undefined;
    const right = this.#integer(node.child1, environment, allowLocalBindings, proof);
    if (right === undefined) return undefined;
    if (node.payload === BinaryOperator.Add) return (left + right) | 0;
    if (node.payload === BinaryOperator.Subtract) return (left - right) | 0;
    if (node.payload === BinaryOperator.Multiply) return Math.imul(left, right);
    if (node.payload === BinaryOperator.Divide && right !== 0) {
      return Math.trunc(left / right) | 0;
    }
    if (node.payload === BinaryOperator.Remainder && right !== 0) {
      return (left % right) | 0;
    }
    if (node.payload === BinaryOperator.BitwiseAnd) return left & right;
    if (node.payload === BinaryOperator.BitwiseOr) return left | right;
    if (node.payload === BinaryOperator.BitwiseXor) return left ^ right;
    if (node.payload === BinaryOperator.ShiftLeft) return left << right;
    if (node.payload === BinaryOperator.ShiftRightUnsigned) return (left >>> right) | 0;
    return undefined;
  }

  #integerComparison(
    node: CoreNode,
    environment: ConstantEnvironment,
    allowLocalBindings: boolean,
    proof: ConstantProof,
  ): boolean | undefined {
    if (!isComparisonOperator(node.payload)) return undefined;
    const left = this.#integer(node.child0, environment, allowLocalBindings, proof);
    if (left === undefined) return undefined;
    const right = this.#integer(node.child1, environment, allowLocalBindings, proof);
    if (right === undefined) return undefined;
    if (node.payload === BinaryOperator.Equal) return left === right;
    if (node.payload === BinaryOperator.NotEqual) return left !== right;
    if (node.payload === BinaryOperator.Less) return left < right;
    if (node.payload === BinaryOperator.LessEqual) return left <= right;
    if (node.payload === BinaryOperator.Greater) return left > right;
    if (node.payload === BinaryOperator.GreaterEqual) return left >= right;
    return undefined;
  }

  #node(nodeIndex: number): CoreNode {
    const node = this.#nodes[nodeIndex];
    if (node === undefined) {
      throw new Error(
        `functional WASM constant analysis references missing core node ${nodeIndex} of ${this.#nodes.length}`,
      );
    }
    return node;
  }
}

interface ConstantProof {
  remainingTransitions: number;
}

function constantProof(): ConstantProof {
  return { remainingTransitions: MAXIMUM_CONSTANT_PROOF_TRANSITIONS };
}

function advanceConstantProof(proof: ConstantProof): boolean {
  if (proof.remainingTransitions === 0) return false;
  proof.remainingTransitions -= 1;
  return true;
}

function constantAt(
  environment: ConstantEnvironment,
  localDepth: number,
): ScalarConstant | undefined {
  return typeof environment === "function" ? environment(localDepth) : environment[localDepth];
}

function extendConstantEnvironment(
  value: ScalarConstant,
  environment: ConstantEnvironment,
): ConstantResolver {
  return (localDepth) => localDepth === 0 ? value : constantAt(environment, localDepth - 1);
}
