import {
  FUNCTIONAL_NO_INDEX,
  FunctionalBinaryOperator,
  FunctionalCoreTag,
  FunctionalEvaluationMode,
  type FunctionalEvaluationMode as FunctionalEvaluationModeValue,
} from "./abi.ts";
import type { FunctionalCoreNode } from "./compiler_module.ts";

export interface FunctionalFunctionShape {
  readonly outerLambdaNode: number;
  readonly innerLambdaNode: number;
  readonly bodyNode: number;
  readonly parameterCount: number;
  readonly strictParameters: readonly boolean[];
  readonly numericParameters: readonly boolean[];
  readonly recursiveLocal: boolean;
  readonly recursiveDefinition: number | undefined;
}

export interface FunctionalCallArgument {
  readonly node: number;
  readonly evaluationMode: FunctionalEvaluationModeValue;
}

export class FunctionalWasmFunctionAnalysis {
  readonly #nodes: readonly FunctionalCoreNode[];
  readonly #functions = new Map<number, FunctionalFunctionShape>();
  readonly #loops = new Map<number, FunctionalFunctionShape>();
  readonly #recursiveFunctions = new Map<
    number,
    { readonly local: boolean; readonly definition: number | undefined }
  >();

  constructor(nodes: readonly FunctionalCoreNode[], definitionRoots: readonly number[]) {
    this.#nodes = nodes;
    for (const node of nodes) {
      if (node.tag !== FunctionalCoreTag.LetRec) continue;
      this.#recursiveFunctions.set(node.child0, { local: true, definition: undefined });
    }
    for (const [definition, rootNode] of definitionRoots.entries()) {
      if (this.#node(rootNode).tag !== FunctionalCoreTag.Lambda) continue;
      this.#recursiveFunctions.set(rootNode, { local: false, definition });
    }
    for (const outerLambdaNode of this.#recursiveFunctions.keys()) {
      this.#registerFunction(outerLambdaNode);
    }
  }

  function(outerLambdaNode: number): FunctionalFunctionShape | undefined {
    return this.#functions.get(outerLambdaNode) ?? this.#registerFunction(outerLambdaNode);
  }

  loop(lambdaNode: number): FunctionalFunctionShape | undefined {
    return this.#loops.get(lambdaNode);
  }

  tailArguments(
    nodeIndex: number,
    loop: FunctionalFunctionShape,
    binderDepth: number,
  ): readonly FunctionalCallArgument[] | undefined {
    const reverseArguments: FunctionalCallArgument[] = [];
    let calleeIndex = nodeIndex;
    let callee = this.#node(calleeIndex);
    while (callee.tag === FunctionalCoreTag.Apply) {
      reverseArguments.push({
        node: callee.child1,
        evaluationMode: callee.evaluationMode,
      });
      calleeIndex = callee.child0;
      callee = this.#node(calleeIndex);
    }
    const localSelf = loop.recursiveLocal && callee.tag === FunctionalCoreTag.Local &&
      callee.payload === binderDepth + loop.parameterCount;
    const globalSelf = loop.recursiveDefinition !== undefined &&
      callee.tag === FunctionalCoreTag.Global && callee.payload === loop.recursiveDefinition;
    if ((!localSelf && !globalSelf) || reverseArguments.length !== loop.parameterCount) {
      return undefined;
    }
    return Object.freeze(reverseArguments.reverse());
  }

  canEvaluateEagerly(nodeIndex: number): boolean {
    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Local:
      case FunctionalCoreTag.Global:
      case FunctionalCoreTag.Lambda:
      case FunctionalCoreTag.Constructor:
        return true;
      case FunctionalCoreTag.Unary:
        return this.canEvaluateEagerly(node.child0);
      case FunctionalCoreTag.Binary:
        return node.payload !== FunctionalBinaryOperator.Divide &&
          this.canEvaluateEagerly(node.child0) && this.canEvaluateEagerly(node.child1);
      case FunctionalCoreTag.If:
        return this.canEvaluateEagerly(node.child0) &&
          this.canEvaluateEagerly(node.child1) && this.canEvaluateEagerly(node.child2);
      case FunctionalCoreTag.Let:
        return this.canEvaluateEagerly(node.child0) && this.canEvaluateEagerly(node.child1);
      default:
        return false;
    }
  }

  #registerFunction(outerLambdaNode: number): FunctionalFunctionShape | undefined {
    const lambdaNodes: number[] = [];
    let bodyNode = outerLambdaNode;
    let body = this.#node(bodyNode);
    while (body.tag === FunctionalCoreTag.Lambda) {
      lambdaNodes.push(bodyNode);
      bodyNode = body.child0;
      body = this.#node(bodyNode);
    }
    const innermostLambda = lambdaNodes.at(-1);
    if (innermostLambda === undefined) return undefined;

    const parameterCount = lambdaNodes.length;
    const provisionalLoop: FunctionalFunctionShape = {
      outerLambdaNode,
      innerLambdaNode: innermostLambda,
      bodyNode,
      parameterCount,
      strictParameters: Array.from({ length: parameterCount }, () => false),
      numericParameters: Array.from({ length: parameterCount }, () => false),
      recursiveLocal: false,
      recursiveDefinition: undefined,
    };
    const recursiveReference = this.#recursiveFunctions.get(outerLambdaNode);
    const recursiveLoop = {
      ...provisionalLoop,
      recursiveLocal: recursiveReference?.local === true,
      recursiveDefinition: recursiveReference?.definition,
    };
    const tailRecursive = recursiveReference !== undefined &&
      this.#containsTailCall(bodyNode, recursiveLoop, 0);
    const strictParameters = tailRecursive
      ? this.#strictParameters(bodyNode, recursiveLoop)
      : this.#directStrictParameters(bodyNode, recursiveLoop);
    const functionShape: FunctionalFunctionShape = {
      ...recursiveLoop,
      strictParameters: Object.freeze(strictParameters),
      numericParameters: Object.freeze(this.#numericParameters(bodyNode, parameterCount)),
    };
    this.#functions.set(outerLambdaNode, functionShape);
    if (tailRecursive) this.#loops.set(innermostLambda, functionShape);
    return functionShape;
  }

  #containsTailCall(
    nodeIndex: number,
    loop: FunctionalFunctionShape,
    binderDepth: number,
  ): boolean {
    if (this.tailArguments(nodeIndex, loop, binderDepth) !== undefined) return true;
    const node = this.#node(nodeIndex);
    if (node.tag === FunctionalCoreTag.If) {
      return this.#containsTailCall(node.child1, loop, binderDepth) ||
        this.#containsTailCall(node.child2, loop, binderDepth);
    }
    return false;
  }

  #strictParameters(
    bodyNode: number,
    loop: FunctionalFunctionShape,
  ): boolean[] {
    let strict = Array.from({ length: loop.parameterCount }, () => true);
    while (true) {
      const demanded = this.#demandedParameters(bodyNode, loop, 0, strict);
      const next = strict.map((_, parameter) => demanded.has(parameter));
      if (next.every((value, parameter) => value === strict[parameter])) return next;
      strict = next;
    }
  }

  #directStrictParameters(
    bodyNode: number,
    loop: FunctionalFunctionShape,
  ): boolean[] {
    const demanded = this.#demandedParameters(
      bodyNode,
      loop,
      0,
      loop.strictParameters,
      false,
    );
    return loop.strictParameters.map((_, parameter) => demanded.has(parameter));
  }

  #demandedParameters(
    nodeIndex: number,
    loop: FunctionalFunctionShape,
    binderDepth: number,
    assumedStrict: readonly boolean[],
    recognizeTailCalls = true,
  ): Set<number> {
    const tailArguments = recognizeTailCalls
      ? this.tailArguments(nodeIndex, loop, binderDepth)
      : undefined;
    if (tailArguments !== undefined) {
      const demanded = new Set<number>();
      for (const [parameter, argument] of tailArguments.entries()) {
        if (
          argument.evaluationMode !== FunctionalEvaluationMode.StrictEager &&
          assumedStrict[parameter] !== true
        ) continue;
        addAll(
          demanded,
          this.#demandedParameters(
            argument.node,
            loop,
            binderDepth,
            assumedStrict,
            recognizeTailCalls,
          ),
        );
      }
      return demanded;
    }

    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Local: {
        const parameterDepth = node.payload - binderDepth;
        if (parameterDepth < 0 || parameterDepth >= loop.parameterCount) return new Set();
        return new Set([loop.parameterCount - parameterDepth - 1]);
      }
      case FunctionalCoreTag.Unary:
        return this.#demandedParameters(
          node.child0,
          loop,
          binderDepth,
          assumedStrict,
          recognizeTailCalls,
        );
      case FunctionalCoreTag.Binary:
        return union(
          this.#demandedParameters(
            node.child0,
            loop,
            binderDepth,
            assumedStrict,
            recognizeTailCalls,
          ),
          this.#demandedParameters(
            node.child1,
            loop,
            binderDepth,
            assumedStrict,
            recognizeTailCalls,
          ),
        );
      case FunctionalCoreTag.If:
        return union(
          this.#demandedParameters(
            node.child0,
            loop,
            binderDepth,
            assumedStrict,
            recognizeTailCalls,
          ),
          intersection(
            this.#demandedParameters(
              node.child1,
              loop,
              binderDepth,
              assumedStrict,
              recognizeTailCalls,
            ),
            this.#demandedParameters(
              node.child2,
              loop,
              binderDepth,
              assumedStrict,
              recognizeTailCalls,
            ),
          ),
        );
      case FunctionalCoreTag.Let:
      case FunctionalCoreTag.LetRec:
        return this.#demandedParameters(
          node.child1,
          loop,
          binderDepth + 1,
          assumedStrict,
          recognizeTailCalls,
        );
      case FunctionalCoreTag.Apply:
        return this.#demandedParameters(
          node.child0,
          loop,
          binderDepth,
          assumedStrict,
          recognizeTailCalls,
        );
      case FunctionalCoreTag.Case:
        return this.#demandedParameters(
          node.child0,
          loop,
          binderDepth,
          assumedStrict,
          recognizeTailCalls,
        );
      default:
        return new Set();
    }
  }

  #numericParameters(bodyNode: number, parameterCount: number): boolean[] {
    const numericParameters = Array.from({ length: parameterCount }, () => false);
    const visit = (nodeIndex: number, binderDepth: number, numericContext: boolean): void => {
      const node = this.#node(nodeIndex);
      if (node.tag === FunctionalCoreTag.Local) {
        if (!numericContext) return;
        const parameterDepth = node.payload - binderDepth;
        if (parameterDepth < 0 || parameterDepth >= parameterCount) return;
        numericParameters[parameterCount - parameterDepth - 1] = true;
        return;
      }
      switch (node.tag) {
        case FunctionalCoreTag.Unary:
          visit(node.child0, binderDepth, true);
          return;
        case FunctionalCoreTag.Binary:
          visit(node.child0, binderDepth, true);
          visit(node.child1, binderDepth, true);
          return;
        case FunctionalCoreTag.Lambda:
        case FunctionalCoreTag.PatternBind:
          visit(node.child0, binderDepth + 1, false);
          return;
        case FunctionalCoreTag.Let:
          visit(node.child0, binderDepth, false);
          visit(node.child1, binderDepth + 1, numericContext);
          return;
        case FunctionalCoreTag.LetRec:
          visit(node.child0, binderDepth + 1, false);
          visit(node.child1, binderDepth + 1, numericContext);
          return;
        case FunctionalCoreTag.Apply:
          visit(node.child0, binderDepth, false);
          visit(node.child1, binderDepth, false);
          return;
        case FunctionalCoreTag.If:
          visit(node.child0, binderDepth, false);
          visit(node.child1, binderDepth, numericContext);
          visit(node.child2, binderDepth, numericContext);
          return;
        case FunctionalCoreTag.Case:
        case FunctionalCoreTag.CaseArm:
          visit(node.child0, binderDepth, false);
          if (node.child1 !== FUNCTIONAL_NO_INDEX) {
            visit(node.child1, binderDepth, numericContext);
          }
          return;
        default:
          return;
      }
    };
    visit(bodyNode, 0, false);
    return numericParameters;
  }

  #node(index: number): FunctionalCoreNode {
    const node = this.#nodes[index];
    if (node === undefined) {
      throw new Error(
        `functional tail-call analysis node ${index} is outside ${this.#nodes.length} resolved nodes`,
      );
    }
    return node;
  }
}

function addAll(target: Set<number>, source: ReadonlySet<number>): void {
  for (const value of source) target.add(value);
}

function union(...sets: readonly ReadonlySet<number>[]): Set<number> {
  const result = new Set<number>();
  for (const set of sets) addAll(result, set);
  return result;
}

function intersection(left: ReadonlySet<number>, right: ReadonlySet<number>): Set<number> {
  const result = new Set<number>();
  for (const value of left) {
    if (right.has(value)) result.add(value);
  }
  return result;
}
