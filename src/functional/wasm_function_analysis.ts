import {
  BinaryOperator,
  CoreTag,
  EvaluationMode,
  type EvaluationMode as EvaluationModeValue,
  NO_INDEX,
  UnaryOperator,
} from "./abi.ts";
import type { CoreNode } from "./compiler_module.ts";
import type { ScalarConstant, WasmConstantAnalysis } from "./wasm_constant_analysis.ts";

type NumericFoldOperator =
  | typeof BinaryOperator.Add
  | typeof BinaryOperator.Multiply;

export interface FunctionShape {
  readonly outerLambdaNode: number;
  readonly innerLambdaNode: number;
  readonly bodyNode: number;
  readonly parameterCount: number;
  readonly strictParameters: readonly boolean[];
  readonly numericParameters: readonly boolean[];
  readonly recursiveLocal: boolean;
  readonly recursiveDefinition: number | undefined;
}

export interface CallArgument {
  readonly node: number;
  readonly evaluationMode: EvaluationModeValue;
}

export interface NumericFold {
  readonly functionShape: FunctionShape;
  readonly operator: NumericFoldOperator;
  readonly conditionNode: number;
  readonly baseNode: number;
  readonly contributionNode: number;
  readonly recursiveArgument: CallArgument;
  readonly recurseWhenTrue: boolean;
}

export class WasmFunctionAnalysis {
  readonly #nodes: readonly CoreNode[];
  readonly #definitionRoots: readonly number[];
  readonly #constantAnalysis: WasmConstantAnalysis;
  readonly #functions = new Map<number, FunctionShape>();
  readonly #loops = new Map<number, FunctionShape>();
  readonly #numericFolds = new Map<number, NumericFold>();
  readonly #recursiveFunctions = new Map<
    number,
    { readonly local: boolean; readonly definition: number | undefined }
  >();

  constructor(
    nodes: readonly CoreNode[],
    definitionRoots: readonly number[],
    constantAnalysis: WasmConstantAnalysis,
  ) {
    this.#nodes = nodes;
    this.#definitionRoots = definitionRoots;
    this.#constantAnalysis = constantAnalysis;
    for (const node of nodes) {
      if (node.tag !== CoreTag.LetRec) continue;
      this.#recursiveFunctions.set(node.child0, { local: true, definition: undefined });
    }
    for (const [definition, rootNode] of definitionRoots.entries()) {
      if (this.#node(rootNode).tag !== CoreTag.Lambda) continue;
      this.#recursiveFunctions.set(rootNode, { local: false, definition });
    }
    for (const outerLambdaNode of this.#recursiveFunctions.keys()) {
      this.#registerFunction(outerLambdaNode);
    }
  }

  function(outerLambdaNode: number): FunctionShape | undefined {
    return this.#functions.get(outerLambdaNode) ?? this.#registerFunction(outerLambdaNode);
  }

  loop(lambdaNode: number): FunctionShape | undefined {
    return this.#loops.get(lambdaNode);
  }

  numericFold(lambdaNode: number): NumericFold | undefined {
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
        readonly environment: readonly (ScalarConstant | undefined)[];
      }[] = [{ nodeIndex: rootNode, environment: [] }];
      while (pendingNodes.length > 0) {
        const pending = pendingNodes.pop();
        if (pending === undefined || visitedNodes.has(pending.nodeIndex)) continue;
        const { nodeIndex, environment } = pending;
        visitedNodes.add(nodeIndex);
        const node = this.#node(nodeIndex);
        if (node.tag === CoreTag.Global) {
          pendingDefinitions.push(node.payload);
          continue;
        }
        if (node.tag === CoreTag.If) {
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
        if (node.tag === CoreTag.Let) {
          pendingNodes.push({ nodeIndex: node.child0, environment });
          const valueNode = this.#node(node.child0);
          const value = node.evaluationMode === EvaluationMode.StrictEager ||
              valueNode.tag === CoreTag.Integer ||
              valueNode.tag === CoreTag.Boolean
            ? this.#constantAnalysis.scalar(node.child0, environment)
            : undefined;
          pendingNodes.push({
            nodeIndex: node.child1,
            environment: [value, ...environment],
          });
          continue;
        }
        if (node.tag === CoreTag.LetRec) {
          const recursiveEnvironment = [undefined, ...environment];
          pendingNodes.push({ nodeIndex: node.child0, environment: recursiveEnvironment });
          pendingNodes.push({ nodeIndex: node.child1, environment: recursiveEnvironment });
          continue;
        }
        if (node.tag === CoreTag.Lambda || node.tag === CoreTag.PatternBind) {
          pendingNodes.push({
            nodeIndex: node.child0,
            environment: [undefined, ...environment],
          });
          continue;
        }
        for (const child of coreNodeChildren(node)) {
          if (child !== NO_INDEX) pendingNodes.push({ nodeIndex: child, environment });
        }
      }
    }
    return definitions;
  }

  tailArguments(
    nodeIndex: number,
    loop: FunctionShape,
    binderDepth: number,
  ): readonly CallArgument[] | undefined {
    const reverseArguments: CallArgument[] = [];
    let calleeIndex = nodeIndex;
    let callee = this.#node(calleeIndex);
    while (callee.tag === CoreTag.Apply) {
      reverseArguments.push({
        node: callee.child1,
        evaluationMode: callee.evaluationMode,
      });
      calleeIndex = callee.child0;
      callee = this.#node(calleeIndex);
    }
    const localSelf = loop.recursiveLocal && callee.tag === CoreTag.Local &&
      callee.payload === binderDepth + loop.parameterCount;
    const globalSelf = loop.recursiveDefinition !== undefined &&
      callee.tag === CoreTag.Global && callee.payload === loop.recursiveDefinition;
    if ((!localSelf && !globalSelf) || reverseArguments.length !== loop.parameterCount) {
      return undefined;
    }
    return Object.freeze(reverseArguments.reverse());
  }

  canEvaluateEagerly(nodeIndex: number): boolean {
    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.Text:
      case CoreTag.Bytes:
      case CoreTag.Local:
      case CoreTag.Global:
      case CoreTag.Lambda:
      case CoreTag.Constructor:
        return true;
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
        return this.canEvaluateEagerly(node.child0);
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
        return node.payload !== BinaryOperator.Divide &&
          this.canEvaluateEagerly(node.child0) && this.canEvaluateEagerly(node.child1);
      case CoreTag.If:
        return this.canEvaluateEagerly(node.child0) &&
          this.canEvaluateEagerly(node.child1) && this.canEvaluateEagerly(node.child2);
      case CoreTag.Let:
        return this.canEvaluateEagerly(node.child0) && this.canEvaluateEagerly(node.child1);
      default:
        return false;
    }
  }

  hasOnlySaturatedSelfReferences(functionShape: FunctionShape): boolean {
    return functionShape.parameterCount >= 1 &&
      !this.#containsSelfReference(functionShape.bodyNode, functionShape, 0, "unsaturated");
  }

  hasOnlyTailSelfReferences(functionShape: FunctionShape): boolean {
    return functionShape.parameterCount >= 1 &&
      !this.#containsNonTailSelfReference(functionShape.bodyNode, functionShape, 0);
  }

  /**
   * The lambda node of a `let`-bound join point, or `undefined` when this `let` is not one.
   *
   * A join point is a `let` whose value is a one-parameter lambda that ignores its parameter and
   * whose binder is referenced only as a saturated call in tail position. That shape compiles to a
   * label rather than a closure: emit the body once after a wasm `block` and turn every call into a
   * `br` to that block's end. The body then sits in the enclosing function's tail position, so a
   * self-tail-call inside it is still a branch to the loop header rather than a stack frame.
   *
   * This exists because {@link WasmFunctionAnalysis.prototype} stops its tail walk at `Lambda`, so
   * without it a tail call inside a `let`-bound lambda silently becomes a real call. Guarded Gleam
   * is exactly this shape — `lowerSequentialCase` binds every later arm to a fallback lambda — and
   * so lost tail recursion and overflowed the stack at 100,000 iterations.
   *
   * Backward jumps never arise: `Let` is non-recursive, so the binder is not in scope inside its own
   * value and the body cannot call the join point. That is what makes a plain forward `block`
   * sufficient rather than a `loop` with a dispatch variable.
   *
   * The parameter is dead, so the argument is dead too and is never emitted. That is only sound if
   * evaluating it could not have done anything, so arguments are restricted to leaves — which have
   * no subexpression to carry an effect — other than `RuntimeFault`, which is an effect by itself.
   */
  joinPointLambda(letNode: number): number | undefined {
    const node = this.#node(letNode);
    if (node.tag !== CoreTag.Let) return undefined;
    const lambda = this.#node(node.child0);
    if (lambda.tag !== CoreTag.Lambda) return undefined;
    if (this.#referencesLocal(lambda.child0, 0)) return undefined;
    if (!this.#joinReferencesAreTailCalls(node.child1, 0, true)) return undefined;
    // A join point nothing branches to would leave its body unreachable rather than shared.
    if (!this.#referencesLocal(node.child1, 0)) return undefined;
    return node.child0;
  }

  /** A leaf carries no subexpression that could have an effect, so a dead one need not be emitted. */
  #argumentIsDiscardable(nodeIndex: number): boolean {
    return this.#node(nodeIndex).tag !== CoreTag.RuntimeFault &&
      this.#children(nodeIndex).length === 0;
  }

  #referencesLocal(nodeIndex: number, localDepth: number): boolean {
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.Local) return node.payload === localDepth;
    for (const [child, depth] of this.#children(nodeIndex)) {
      if (this.#referencesLocal(child, localDepth + depth)) return true;
    }
    return false;
  }

  /**
   * Whether every reference to the join binder at `localDepth` is a one-argument call in tail
   * position. Anything else — a bare reference, an over-application, a call from a value position,
   * a use inside a nested lambda — means the binder escapes and cannot become a label.
   */
  #joinReferencesAreTailCalls(
    nodeIndex: number,
    localDepth: number,
    tail: boolean,
  ): boolean {
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.Apply) {
      const callee = this.#node(node.child0);
      if (callee.tag === CoreTag.Local && callee.payload === localDepth) {
        return tail && this.#argumentIsDiscardable(node.child1);
      }
    }
    if (node.tag === CoreTag.Local) return node.payload !== localDepth;
    for (const [child, depth, childTail] of this.#children(nodeIndex)) {
      if (!this.#joinReferencesAreTailCalls(child, localDepth + depth, tail && childTail)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Every child of a node as `[childIndex, bindersIntroduced, inheritsTailPosition]`.
   *
   * Written once and shared by the join-point predicates so the two cannot disagree about which
   * positions are tail, and so an unhandled tag is a loud `never` at compile time rather than a
   * silently unvisited reference.
   */
  #children(nodeIndex: number): readonly (readonly [number, number, boolean])[] {
    const node = this.#node(nodeIndex);
    const child = (index: number, binders: number, tail: boolean) =>
      index === NO_INDEX ? [] : [[index, binders, tail] as const];
    switch (node.tag) {
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.Text:
      case CoreTag.Bytes:
      case CoreTag.RuntimeFault:
      case CoreTag.StoreEmpty:
      case CoreTag.Local:
      case CoreTag.Global:
      case CoreTag.Constructor:
        return [];
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
        return child(node.child0, 0, false);
      case CoreTag.Apply:
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
      case CoreTag.StoreRead:
        return [...child(node.child0, 0, false), ...child(node.child1, 0, false)];
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
        return [
          ...child(node.child0, 0, false),
          ...child(node.child1, 0, false),
          ...child(node.child2, 0, false),
        ];
      case CoreTag.If:
        return [
          ...child(node.child0, 0, false),
          ...child(node.child1, 0, true),
          ...child(node.child2, 0, true),
        ];
      case CoreTag.Lambda:
        return child(node.child0, 1, false);
      case CoreTag.PatternBind:
        return child(node.child0, 1, true);
      case CoreTag.Let:
        return [...child(node.child0, 0, false), ...child(node.child1, 1, true)];
      case CoreTag.LetRec:
        return [...child(node.child0, 1, false), ...child(node.child1, 1, true)];
      case CoreTag.Case:
        return [...child(node.child0, 0, false), ...child(node.child1, 0, true)];
      case CoreTag.CaseArm:
        return [...child(node.child0, 0, true), ...child(node.child1, 0, true)];
      case CoreTag.Prim:
        throw new Error("WebAssembly join-point analysis received an unlowered primop");
    }
    const unhandled: never = node.tag;
    throw new Error(`WebAssembly join-point analysis met an unknown Core tag ${unhandled}`);
  }

  #containsNonTailSelfReference(
    nodeIndex: number,
    functionShape: FunctionShape,
    binderDepth: number,
  ): boolean {
    if (this.tailArguments(nodeIndex, functionShape, binderDepth) !== undefined) {
      return false;
    }
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.PatternBind) {
      return this.#containsNonTailSelfReference(
        node.child0,
        functionShape,
        binderDepth + 1,
      );
    }
    if (node.tag === CoreTag.Let || node.tag === CoreTag.LetRec) {
      return this.#containsSelfReference(
        node.child0,
        functionShape,
        binderDepth + (node.tag === CoreTag.LetRec ? 1 : 0),
        "any",
      ) || this.#containsNonTailSelfReference(
        node.child1,
        functionShape,
        binderDepth + 1,
      );
    }
    if (node.tag === CoreTag.Case) {
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
    if (node.tag === CoreTag.CaseArm) {
      return this.#containsNonTailSelfReference(
        node.child0,
        functionShape,
        binderDepth,
      ) || node.child1 !== NO_INDEX && this.#containsNonTailSelfReference(
            node.child1,
            functionShape,
            binderDepth,
          );
    }
    if (node.tag !== CoreTag.If) {
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

  #registerFunction(outerLambdaNode: number): FunctionShape | undefined {
    const lambdaNodes: number[] = [];
    let bodyNode = outerLambdaNode;
    let body = this.#node(bodyNode);
    while (body.tag === CoreTag.Lambda) {
      lambdaNodes.push(bodyNode);
      bodyNode = body.child0;
      body = this.#node(bodyNode);
    }
    const innermostLambda = lambdaNodes.at(-1);
    if (innermostLambda === undefined) return undefined;

    const parameterCount = lambdaNodes.length;
    const provisionalLoop: FunctionShape = {
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
    const functionShape: FunctionShape = {
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

  #numericFold(functionShape: FunctionShape): NumericFold | undefined {
    if (functionShape.parameterCount !== 1) return undefined;
    const body = this.#node(functionShape.bodyNode);
    if (body.tag !== CoreTag.If) return undefined;
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
    functionShape: FunctionShape,
  ):
    | {
      readonly operator: NumericFoldOperator;
      readonly contributionNode: number;
      readonly recursiveArgument: CallArgument;
    }
    | undefined {
    const node = this.#node(nodeIndex);
    if (
      node.tag !== CoreTag.Binary ||
      (node.payload !== BinaryOperator.Add &&
        node.payload !== BinaryOperator.Multiply)
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
    functionShape: FunctionShape,
    binderDepth: number,
    scope: "any" | "unsaturated",
  ): boolean {
    if (this.tailArguments(nodeIndex, functionShape, binderDepth) !== undefined) {
      return scope === "any";
    }
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.Local) {
      return functionShape.recursiveLocal &&
        node.payload === binderDepth + functionShape.parameterCount;
    }
    if (node.tag === CoreTag.Global) {
      return functionShape.recursiveDefinition !== undefined &&
        node.payload === functionShape.recursiveDefinition;
    }
    switch (node.tag) {
      case CoreTag.Prim:
        throw new Error("WebAssembly function analysis received an unlowered primop");
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.Text:
      case CoreTag.Bytes:
      case CoreTag.RuntimeFault:
      case CoreTag.StoreEmpty:
      case CoreTag.Constructor:
        return false;
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth,
          scope,
        );
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
      case CoreTag.Apply:
      case CoreTag.StoreNew:
      case CoreTag.StoreRead:
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
      case CoreTag.If:
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
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
      case CoreTag.Lambda:
      case CoreTag.PatternBind:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth + 1,
          scope,
        );
      case CoreTag.Let:
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
      case CoreTag.LetRec:
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
      case CoreTag.Case:
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
      case CoreTag.CaseArm:
        return this.#containsSelfReference(
          node.child0,
          functionShape,
          binderDepth,
          scope,
        ) || node.child1 !== NO_INDEX && this.#containsSelfReference(
              node.child1,
              functionShape,
              binderDepth,
              scope,
            );
    }
  }

  #containsTailCall(
    nodeIndex: number,
    loop: FunctionShape,
    binderDepth: number,
  ): boolean {
    if (this.tailArguments(nodeIndex, loop, binderDepth) !== undefined) return true;
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.PatternBind) {
      return this.#containsTailCall(node.child0, loop, binderDepth + 1);
    }
    if (node.tag === CoreTag.Let || node.tag === CoreTag.LetRec) {
      if (this.#containsTailCall(node.child1, loop, binderDepth + 1)) return true;
      // A contified join point's body is emitted in tail position, so a self-call inside it is a
      // tail call. Detecting that here is what registers the enclosing function as a loop at all --
      // codegen can only contify a function it was told is one.
      const joinLambda = node.tag === CoreTag.Let ? this.joinPointLambda(nodeIndex) : undefined;
      if (joinLambda === undefined) return false;
      return this.#containsTailCall(this.#node(joinLambda).child0, loop, binderDepth + 1);
    }
    if (node.tag === CoreTag.Case) {
      return this.#containsTailCall(node.child1, loop, binderDepth);
    }
    if (node.tag === CoreTag.CaseArm) {
      return this.#containsTailCall(node.child0, loop, binderDepth) ||
        node.child1 !== NO_INDEX &&
          this.#containsTailCall(node.child1, loop, binderDepth);
    }
    if (node.tag === CoreTag.If) {
      return this.#containsTailCall(node.child1, loop, binderDepth) ||
        this.#containsTailCall(node.child2, loop, binderDepth);
    }
    return false;
  }

  #strictParameters(
    bodyNode: number,
    loop: FunctionShape,
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
    loop: FunctionShape,
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
    loop: FunctionShape,
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
          argument.evaluationMode !== EvaluationMode.StrictEager &&
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
      case CoreTag.Local: {
        const parameterDepth = node.payload - binderDepth;
        if (parameterDepth < 0 || parameterDepth >= loop.parameterCount) return new Set();
        return new Set([loop.parameterCount - parameterDepth - 1]);
      }
      case CoreTag.Unary:
        return this.#demandedParameters(
          node.child0,
          loop,
          binderDepth,
          assumedStrict,
          recognizeTailCalls,
        );
      case CoreTag.Binary:
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
      case CoreTag.If:
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
      case CoreTag.Let:
      case CoreTag.LetRec:
        return this.#demandedParameters(
          node.child1,
          loop,
          binderDepth + 1,
          assumedStrict,
          recognizeTailCalls,
        );
      case CoreTag.Apply:
        return this.#demandedParameters(
          node.child0,
          loop,
          binderDepth,
          assumedStrict,
          recognizeTailCalls,
        );
      case CoreTag.Case:
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
      if (node.tag === CoreTag.Local) {
        if (!numericContext) return;
        const parameterDepth = node.payload - binderDepth;
        if (parameterDepth < 0 || parameterDepth >= parameterCount) return;
        numericParameters[parameterCount - parameterDepth - 1] = true;
        return;
      }
      switch (node.tag) {
        case CoreTag.Unary:
          visit(
            node.child0,
            binderDepth,
            node.payload === UnaryOperator.Negate,
          );
          return;
        case CoreTag.Binary:
          visit(node.child0, binderDepth, integerOperator(node.payload));
          visit(node.child1, binderDepth, integerOperator(node.payload));
          return;
        case CoreTag.Lambda:
        case CoreTag.PatternBind:
          visit(node.child0, binderDepth + 1, false);
          return;
        case CoreTag.Let:
          visit(node.child0, binderDepth, false);
          visit(node.child1, binderDepth + 1, numericContext);
          return;
        case CoreTag.LetRec:
          visit(node.child0, binderDepth + 1, false);
          visit(node.child1, binderDepth + 1, numericContext);
          return;
        case CoreTag.Apply:
          visit(node.child0, binderDepth, false);
          visit(node.child1, binderDepth, false);
          return;
        case CoreTag.If:
          visit(node.child0, binderDepth, false);
          visit(node.child1, binderDepth, numericContext);
          visit(node.child2, binderDepth, numericContext);
          return;
        case CoreTag.Case:
        case CoreTag.CaseArm:
          visit(node.child0, binderDepth, false);
          if (node.child1 !== NO_INDEX) {
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

  #node(index: number): CoreNode {
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
  return operator >= BinaryOperator.Equal &&
      operator <= BinaryOperator.Divide ||
    operator >= BinaryOperator.Remainder &&
      operator <= BinaryOperator.ShiftRightUnsigned;
}

function coreNodeChildren(node: CoreNode): readonly number[] {
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
    case CoreTag.StoreEmpty:
    case CoreTag.Local:
    case CoreTag.Global:
    case CoreTag.Constructor:
      return [];
    case CoreTag.Prim:
      throw new Error("WebAssembly function analysis received an unlowered primop");
    case CoreTag.Lambda:
    case CoreTag.Unary:
    case CoreTag.NumericConvert:
    case CoreTag.PatternBind:
    case CoreTag.StoreLength:
      return [node.child0];
    case CoreTag.Apply:
    case CoreTag.Let:
    case CoreTag.LetRec:
    case CoreTag.Binary:
    case CoreTag.BufferAppend:
    case CoreTag.Case:
    case CoreTag.CaseArm:
    case CoreTag.StoreNew:
    case CoreTag.StoreRead:
      return [node.child0, node.child1];
    case CoreTag.If:
    case CoreTag.StoreWrite:
    case CoreTag.StoreGrow:
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
