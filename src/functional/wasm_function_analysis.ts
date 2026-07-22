import {
  FUNCTIONAL_NO_INDEX,
  FunctionalBinaryOperator,
  FunctionalCoreTag,
  FunctionalEvaluationMode,
  type FunctionalEvaluationMode as FunctionalEvaluationModeValue,
  FunctionalUnaryOperator,
} from "./abi.ts";
import type { FunctionalCoreNode } from "./compiler_module.ts";
import type {
  FunctionalScalarConstant,
  FunctionalWasmConstantAnalysis,
} from "./wasm_constant_analysis.ts";

type FunctionalNumericFoldOperator =
  | typeof FunctionalBinaryOperator.Add
  | typeof FunctionalBinaryOperator.Multiply;

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

export interface FunctionalNumericFold {
  readonly functionShape: FunctionalFunctionShape;
  readonly operator: FunctionalNumericFoldOperator;
  readonly conditionNode: number;
  readonly baseNode: number;
  readonly contributionNode: number;
  readonly recursiveArgument: FunctionalCallArgument;
  readonly recurseWhenTrue: boolean;
}

export class FunctionalWasmFunctionAnalysis {
  readonly #nodes: readonly FunctionalCoreNode[];
  readonly #definitionRoots: readonly number[];
  readonly #constantAnalysis: FunctionalWasmConstantAnalysis;
  readonly #functions = new Map<number, FunctionalFunctionShape>();
  readonly #loops = new Map<number, FunctionalFunctionShape>();
  readonly #numericFolds = new Map<number, FunctionalNumericFold>();
  readonly #recursiveFunctions = new Map<
    number,
    { readonly local: boolean; readonly definition: number | undefined }
  >();

  constructor(
    nodes: readonly FunctionalCoreNode[],
    definitionRoots: readonly number[],
    constantAnalysis: FunctionalWasmConstantAnalysis,
  ) {
    this.#nodes = nodes;
    this.#definitionRoots = definitionRoots;
    this.#constantAnalysis = constantAnalysis;
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

  numericFold(lambdaNode: number): FunctionalNumericFold | undefined {
    return this.#numericFolds.get(lambdaNode);
  }

  reachableDefinitions(
    rootDefinitions: readonly number[],
    options: { readonly constantBranches: "prune" | "preserve" },
  ): ReadonlySet<number> {
    const definitions = new Set<number>();
    const visitedNodes = new Set<number>();
    const pendingDefinitions = [...rootDefinitions];
    while (pendingDefinitions.length > 0) {
      const definition = pendingDefinitions.pop();
      if (definition === undefined || definitions.has(definition)) continue;
      const rootNode = this.#definitionRoots[definition];
      if (rootNode === undefined) {
        throw new Error(
          `functional WASM reachability root d${definition} exceeds ${this.#definitionRoots.length} definitions`,
        );
      }
      definitions.add(definition);
      const pendingNodes: {
        readonly nodeIndex: number;
        readonly environment: readonly (FunctionalScalarConstant | undefined)[];
      }[] = [{ nodeIndex: rootNode, environment: [] }];
      while (pendingNodes.length > 0) {
        const pending = pendingNodes.pop();
        if (pending === undefined || visitedNodes.has(pending.nodeIndex)) continue;
        const { nodeIndex, environment } = pending;
        visitedNodes.add(nodeIndex);
        const node = this.#node(nodeIndex);
        if (node.tag === FunctionalCoreTag.Global) {
          pendingDefinitions.push(node.payload);
          continue;
        }
        if (node.tag === FunctionalCoreTag.If) {
          pendingNodes.push({ nodeIndex: node.child0, environment });
          const condition = options.constantBranches === "prune"
            ? this.#constantAnalysis.boolean(node.child0, environment)
            : undefined;
          if (condition === undefined) {
            pendingNodes.push({ nodeIndex: node.child1, environment });
            pendingNodes.push({ nodeIndex: node.child2, environment });
          } else {
            pendingNodes.push({
              nodeIndex: condition ? node.child1 : node.child2,
              environment,
            });
          }
          continue;
        }
        if (node.tag === FunctionalCoreTag.Let) {
          pendingNodes.push({ nodeIndex: node.child0, environment });
          const valueNode = this.#node(node.child0);
          const value = node.evaluationMode === FunctionalEvaluationMode.StrictEager ||
              valueNode.tag === FunctionalCoreTag.Integer ||
              valueNode.tag === FunctionalCoreTag.Boolean
            ? this.#constantAnalysis.scalar(node.child0, environment)
            : undefined;
          pendingNodes.push({
            nodeIndex: node.child1,
            environment: [value, ...environment],
          });
          continue;
        }
        if (node.tag === FunctionalCoreTag.LetRec) {
          const recursiveEnvironment = [undefined, ...environment];
          pendingNodes.push({ nodeIndex: node.child0, environment: recursiveEnvironment });
          pendingNodes.push({ nodeIndex: node.child1, environment: recursiveEnvironment });
          continue;
        }
        if (node.tag === FunctionalCoreTag.Lambda || node.tag === FunctionalCoreTag.PatternBind) {
          pendingNodes.push({
            nodeIndex: node.child0,
            environment: [undefined, ...environment],
          });
          continue;
        }
        for (const child of coreNodeChildren(node)) {
          if (child !== FUNCTIONAL_NO_INDEX) pendingNodes.push({ nodeIndex: child, environment });
        }
      }
    }
    return definitions;
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
      case FunctionalCoreTag.SignedInteger64:
      case FunctionalCoreTag.Float32:
      case FunctionalCoreTag.Float64:
      case FunctionalCoreTag.WholeNumberF64:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Text:
      case FunctionalCoreTag.Bytes:
      case FunctionalCoreTag.Local:
      case FunctionalCoreTag.Global:
      case FunctionalCoreTag.Lambda:
      case FunctionalCoreTag.Constructor:
        return true;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.NumericConvert:
      case FunctionalCoreTag.StoreLength:
        return this.canEvaluateEagerly(node.child0);
      case FunctionalCoreTag.Binary:
      case FunctionalCoreTag.BufferAppend:
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

  hasOnlySaturatedSelfReferences(functionShape: FunctionalFunctionShape): boolean {
    return functionShape.parameterCount >= 1 &&
      !this.#containsSelfReference(functionShape.bodyNode, functionShape, 0, "unsaturated");
  }

  hasOnlyTailSelfReferences(functionShape: FunctionalFunctionShape): boolean {
    return functionShape.parameterCount >= 1 &&
      !this.#containsNonTailSelfReference(functionShape.bodyNode, functionShape, 0);
  }

  #containsNonTailSelfReference(
    nodeIndex: number,
    functionShape: FunctionalFunctionShape,
    binderDepth: number,
  ): boolean {
    if (this.tailArguments(nodeIndex, functionShape, binderDepth) !== undefined) {
      return false;
    }
    const node = this.#node(nodeIndex);
    if (node.tag === FunctionalCoreTag.PatternBind) {
      return this.#containsNonTailSelfReference(
        node.child0,
        functionShape,
        binderDepth + 1,
      );
    }
    if (node.tag === FunctionalCoreTag.Let || node.tag === FunctionalCoreTag.LetRec) {
      return this.#containsSelfReference(
        node.child0,
        functionShape,
        binderDepth + (node.tag === FunctionalCoreTag.LetRec ? 1 : 0),
        "any",
      ) || this.#containsNonTailSelfReference(
        node.child1,
        functionShape,
        binderDepth + 1,
      );
    }
    if (node.tag === FunctionalCoreTag.Case) {
      return this.#containsSelfReference(
        node.child0,
        functionShape,
        binderDepth,
        "any",
      ) || this.#containsNonTailSelfReference(
        node.child1,
        functionShape,
        binderDepth,
      );
    }
    if (node.tag === FunctionalCoreTag.CaseArm) {
      return this.#containsNonTailSelfReference(
        node.child0,
        functionShape,
        binderDepth,
      ) || node.child1 !== FUNCTIONAL_NO_INDEX && this.#containsNonTailSelfReference(
            node.child1,
            functionShape,
            binderDepth,
          );
    }
    if (node.tag !== FunctionalCoreTag.If) {
      return this.#containsSelfReference(
        nodeIndex,
        functionShape,
        binderDepth,
        "any",
      );
    }
    return this.#containsSelfReference(
      node.child0,
      functionShape,
      binderDepth,
      "any",
    ) || this.#containsNonTailSelfReference(
      node.child1,
      functionShape,
      binderDepth,
    ) || this.#containsNonTailSelfReference(
      node.child2,
      functionShape,
      binderDepth,
    );
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
    if (tailRecursive) {
      this.#loops.set(innermostLambda, functionShape);
    } else {
      const numericFold = this.#numericFold(functionShape);
      if (numericFold !== undefined) this.#numericFolds.set(innermostLambda, numericFold);
    }
    return functionShape;
  }

  #numericFold(functionShape: FunctionalFunctionShape): FunctionalNumericFold | undefined {
    if (functionShape.parameterCount !== 1) return undefined;
    const body = this.#node(functionShape.bodyNode);
    if (body.tag !== FunctionalCoreTag.If) return undefined;
    if (this.#containsSelfReference(body.child0, functionShape, 0, "any")) return undefined;

    const consequent = this.#numericFoldStep(body.child1, functionShape);
    const alternate = this.#numericFoldStep(body.child2, functionShape);
    if ((consequent === undefined) === (alternate === undefined)) return undefined;
    const step = consequent ?? alternate;
    if (step === undefined) return undefined;
    const baseNode = consequent === undefined ? body.child1 : body.child2;
    if (this.#containsSelfReference(baseNode, functionShape, 0, "any")) return undefined;
    return {
      functionShape,
      operator: step.operator,
      conditionNode: body.child0,
      baseNode,
      contributionNode: step.contributionNode,
      recursiveArgument: step.recursiveArgument,
      recurseWhenTrue: consequent !== undefined,
    };
  }

  #numericFoldStep(
    nodeIndex: number,
    functionShape: FunctionalFunctionShape,
  ):
    | {
      readonly operator: FunctionalNumericFoldOperator;
      readonly contributionNode: number;
      readonly recursiveArgument: FunctionalCallArgument;
    }
    | undefined {
    const node = this.#node(nodeIndex);
    if (
      node.tag !== FunctionalCoreTag.Binary ||
      (node.payload !== FunctionalBinaryOperator.Add &&
        node.payload !== FunctionalBinaryOperator.Multiply)
    ) return undefined;

    const rightRecursiveArguments = this.tailArguments(node.child1, functionShape, 0);
    if (rightRecursiveArguments === undefined) return undefined;
    const recursiveArgument = rightRecursiveArguments[0];
    if (recursiveArgument === undefined) return undefined;
    if (this.#containsSelfReference(recursiveArgument.node, functionShape, 0, "any")) {
      return undefined;
    }
    const contributionNode = node.child0;
    if (this.#containsSelfReference(contributionNode, functionShape, 0, "any")) return undefined;
    return {
      operator: node.payload,
      contributionNode,
      recursiveArgument,
    };
  }

  #containsSelfReference(
    nodeIndex: number,
    functionShape: FunctionalFunctionShape,
    binderDepth: number,
    scope: "any" | "unsaturated",
  ): boolean {
    if (this.tailArguments(nodeIndex, functionShape, binderDepth) !== undefined) {
      return scope === "any";
    }
    const node = this.#node(nodeIndex);
    if (node.tag === FunctionalCoreTag.Local) {
      return functionShape.recursiveLocal &&
        node.payload === binderDepth + functionShape.parameterCount;
    }
    if (node.tag === FunctionalCoreTag.Global) {
      return functionShape.recursiveDefinition !== undefined &&
        node.payload === functionShape.recursiveDefinition;
    }
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
      case FunctionalCoreTag.SignedInteger64:
      case FunctionalCoreTag.Float32:
      case FunctionalCoreTag.Float64:
      case FunctionalCoreTag.WholeNumberF64:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Text:
      case FunctionalCoreTag.Bytes:
      case FunctionalCoreTag.RuntimeFault:
      case FunctionalCoreTag.Constructor:
        return false;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.NumericConvert:
      case FunctionalCoreTag.StoreLength:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth,
          scope,
        );
      case FunctionalCoreTag.Binary:
      case FunctionalCoreTag.BufferAppend:
      case FunctionalCoreTag.Apply:
      case FunctionalCoreTag.StoreNew:
      case FunctionalCoreTag.StoreRead:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth,
          scope,
        ) || this.#containsSelfReference(
          node.child1,
          functionShape,
          binderDepth,
          scope,
        );
      case FunctionalCoreTag.If:
      case FunctionalCoreTag.StoreWrite:
      case FunctionalCoreTag.StoreGrow:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth,
          scope,
        ) || this.#containsSelfReference(
          node.child1,
          functionShape,
          binderDepth,
          scope,
        ) || this.#containsSelfReference(
          node.child2,
          functionShape,
          binderDepth,
          scope,
        );
      case FunctionalCoreTag.Lambda:
      case FunctionalCoreTag.PatternBind:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth + 1,
          scope,
        );
      case FunctionalCoreTag.Let:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth,
          scope,
        ) || this.#containsSelfReference(
          node.child1,
          functionShape,
          binderDepth + 1,
          scope,
        );
      case FunctionalCoreTag.LetRec:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth + 1,
          scope,
        ) || this.#containsSelfReference(
          node.child1,
          functionShape,
          binderDepth + 1,
          scope,
        );
      case FunctionalCoreTag.Case:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth,
          scope,
        ) || this.#containsSelfReference(
          node.child1,
          functionShape,
          binderDepth,
          scope,
        );
      case FunctionalCoreTag.CaseArm:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth,
          scope,
        ) || node.child1 !== FUNCTIONAL_NO_INDEX && this.#containsSelfReference(
              node.child1,
              functionShape,
              binderDepth,
              scope,
            );
    }
  }

  #containsTailCall(
    nodeIndex: number,
    loop: FunctionalFunctionShape,
    binderDepth: number,
  ): boolean {
    if (this.tailArguments(nodeIndex, loop, binderDepth) !== undefined) return true;
    const node = this.#node(nodeIndex);
    if (node.tag === FunctionalCoreTag.PatternBind) {
      return this.#containsTailCall(node.child0, loop, binderDepth + 1);
    }
    if (node.tag === FunctionalCoreTag.Let || node.tag === FunctionalCoreTag.LetRec) {
      return this.#containsTailCall(node.child1, loop, binderDepth + 1);
    }
    if (node.tag === FunctionalCoreTag.Case) {
      return this.#containsTailCall(node.child1, loop, binderDepth);
    }
    if (node.tag === FunctionalCoreTag.CaseArm) {
      return this.#containsTailCall(node.child0, loop, binderDepth) ||
        node.child1 !== FUNCTIONAL_NO_INDEX &&
          this.#containsTailCall(node.child1, loop, binderDepth);
    }
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
          visit(
            node.child0,
            binderDepth,
            node.payload === FunctionalUnaryOperator.Negate,
          );
          return;
        case FunctionalCoreTag.Binary:
          visit(node.child0, binderDepth, integerOperator(node.payload));
          visit(node.child1, binderDepth, integerOperator(node.payload));
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

function integerOperator(operator: number): boolean {
  return operator >= FunctionalBinaryOperator.Equal &&
      operator <= FunctionalBinaryOperator.Divide ||
    operator >= FunctionalBinaryOperator.Remainder &&
      operator <= FunctionalBinaryOperator.ShiftRightUnsigned;
}

function coreNodeChildren(node: FunctionalCoreNode): readonly number[] {
  switch (node.tag) {
    case FunctionalCoreTag.SignedInteger64:
    case FunctionalCoreTag.Float64:
    case FunctionalCoreTag.WholeNumberF64:
    case FunctionalCoreTag.Integer:
    case FunctionalCoreTag.Float32:
    case FunctionalCoreTag.Boolean:
    case FunctionalCoreTag.Text:
    case FunctionalCoreTag.Bytes:
    case FunctionalCoreTag.RuntimeFault:
    case FunctionalCoreTag.Local:
    case FunctionalCoreTag.Global:
    case FunctionalCoreTag.Constructor:
      return [];
    case FunctionalCoreTag.Lambda:
    case FunctionalCoreTag.Unary:
    case FunctionalCoreTag.NumericConvert:
    case FunctionalCoreTag.PatternBind:
    case FunctionalCoreTag.StoreLength:
      return [node.child0];
    case FunctionalCoreTag.Apply:
    case FunctionalCoreTag.Let:
    case FunctionalCoreTag.LetRec:
    case FunctionalCoreTag.Binary:
    case FunctionalCoreTag.BufferAppend:
    case FunctionalCoreTag.Case:
    case FunctionalCoreTag.CaseArm:
    case FunctionalCoreTag.StoreNew:
    case FunctionalCoreTag.StoreRead:
      return [node.child0, node.child1];
    case FunctionalCoreTag.If:
    case FunctionalCoreTag.StoreWrite:
    case FunctionalCoreTag.StoreGrow:
      return [node.child0, node.child1, node.child2];
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
