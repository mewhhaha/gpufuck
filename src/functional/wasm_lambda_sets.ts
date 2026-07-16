import { FUNCTIONAL_NO_INDEX, FunctionalCoreTag } from "./abi.ts";
import type { FunctionalCoreNode, GpuFunctionalModule } from "./compiler_module.ts";
import { FUNCTIONAL_INIT_CONSTRUCTOR_NAME } from "./host_contract.ts";

// Wider sets retain the ordinary closure path so adversarial modules cannot inflate dispatch code.
const MAXIMUM_LAMBDA_SET_SIZE = 64;

export interface FunctionalLambdaSet {
  readonly lambdaNodes: readonly number[];
  readonly complete: boolean;
}

interface FlowState {
  readonly lambdaNodes: Set<number>;
  incomplete: boolean;
}

interface ApplicationConstraint {
  readonly callee: number;
  readonly argument: number;
  readonly result: number;
  readonly connectedLambdaNodes: Set<number>;
}

interface ParentEdge {
  readonly parent: number;
  readonly child: 0 | 1 | 2;
}

interface ConstructorApplication {
  readonly constructor: number;
  readonly arguments: readonly number[];
}

/**
 * Computes finite lambda provenance over the resolved core. The analysis is deliberately
 * representation-only: semantic function types remain unchanged, while an incomplete set makes
 * code generation retain the ordinary closure call.
 */
export class FunctionalLambdaSetAnalysis {
  readonly #module: GpuFunctionalModule;
  readonly #nodes: readonly FunctionalCoreNode[];
  readonly #states: FlowState[];
  readonly #edges: Set<number>[];
  readonly #applicationsByCallee: ApplicationConstraint[][];
  readonly #lambdaBodies = new Map<number, number>();
  readonly #constructorFieldOffsets: readonly number[];
  readonly #binderBase: number;
  readonly #definitionBase: number;
  readonly #constructorFieldBase: number;
  readonly #externalValue: number;
  readonly #workQueue: number[] = [];
  readonly #queued: boolean[];

  constructor(module: GpuFunctionalModule, nodes: readonly FunctionalCoreNode[]) {
    this.#module = module;
    this.#nodes = nodes;
    this.#binderBase = nodes.length;
    this.#definitionBase = this.#binderBase + nodes.length;
    this.#constructorFieldBase = this.#definitionBase + module.definitionCount;

    const constructorFieldOffsets = [0];
    for (const arity of module.constructorArities) {
      constructorFieldOffsets.push(constructorFieldOffsets.at(-1)! + arity);
    }
    this.#constructorFieldOffsets = Object.freeze(constructorFieldOffsets);
    this.#externalValue = this.#constructorFieldBase + constructorFieldOffsets.at(-1)!;

    const flowVariableCount = this.#externalValue + 1;
    this.#states = Array.from(
      { length: flowVariableCount },
      () => ({ lambdaNodes: new Set<number>(), incomplete: false }),
    );
    this.#edges = Array.from({ length: flowVariableCount }, () => new Set<number>());
    this.#applicationsByCallee = Array.from({ length: flowVariableCount }, () => []);
    this.#queued = Array.from({ length: flowVariableCount }, () => false);

    this.#markIncomplete(this.#externalValue);
    this.#markEscapingConstructorFieldsIncomplete();
    for (const [constructor, name] of module.constructorNames.entries()) {
      if (name !== FUNCTIONAL_INIT_CONSTRUCTOR_NAME) continue;
      for (let field = 0; field < module.constructorArities[constructor]!; field++) {
        this.#markIncomplete(this.#constructorField(constructor, field));
      }
    }

    for (const [definition, root] of module.definitionRoots.entries()) {
      this.#visitExpression(root, []);
      this.#addEdge(this.#nodeVariable(root), this.#definitionVariable(definition));
    }

    const entryApplication: ApplicationConstraint = {
      callee: this.#definitionVariable(module.entryDefinition),
      argument: this.#externalValue,
      result: this.#externalValue,
      connectedLambdaNodes: new Set<number>(),
    };
    this.#applicationsByCallee[entryApplication.callee]!.push(entryApplication);
    this.#enqueue(entryApplication.callee);
    this.#solve();
  }

  lambdaSet(nodeIndex: number): FunctionalLambdaSet {
    const state = this.#state(this.#nodeVariable(nodeIndex));
    return Object.freeze({
      lambdaNodes: Object.freeze([...state.lambdaNodes].sort((left, right) => left - right)),
      complete: !state.incomplete,
    });
  }

  #visitExpression(nodeIndex: number, environment: readonly number[]): void {
    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
      case FunctionalCoreTag.Boolean:
        return;
      case FunctionalCoreTag.Local: {
        const binding = environment[node.payload];
        if (binding === undefined) {
          throw new Error(
            `functional lambda-set local depth ${node.payload} at node ${nodeIndex} exceeds environment depth ${environment.length}`,
          );
        }
        this.#addEdge(binding, this.#nodeVariable(nodeIndex));
        return;
      }
      case FunctionalCoreTag.Global:
        if (node.payload >= this.#module.definitionCount) {
          throw new Error(
            `functional lambda-set global d${node.payload} at node ${nodeIndex} exceeds ${this.#module.definitionCount} definitions`,
          );
        }
        this.#addEdge(this.#definitionVariable(node.payload), this.#nodeVariable(nodeIndex));
        return;
      case FunctionalCoreTag.Constructor:
        if (this.#module.constructorArities[node.payload] === undefined) {
          throw new Error(
            `functional lambda-set constructor ${node.payload} at node ${nodeIndex} exceeds ${this.#module.constructorCount} constructors`,
          );
        } else if (this.#module.constructorArities[node.payload]! > 0) {
          this.#markIncomplete(this.#nodeVariable(nodeIndex));
        }
        return;
      case FunctionalCoreTag.Lambda: {
        this.#addLambda(this.#nodeVariable(nodeIndex), nodeIndex);
        this.#lambdaBodies.set(nodeIndex, node.child0);
        this.#visitExpression(node.child0, [this.#binderVariable(nodeIndex), ...environment]);
        return;
      }
      case FunctionalCoreTag.Apply:
        this.#visitExpression(node.child0, environment);
        this.#visitExpression(node.child1, environment);
        this.#visitApplication(nodeIndex);
        return;
      case FunctionalCoreTag.Let:
        this.#visitExpression(node.child0, environment);
        this.#addEdge(this.#nodeVariable(node.child0), this.#binderVariable(nodeIndex));
        this.#visitExpression(node.child1, [this.#binderVariable(nodeIndex), ...environment]);
        this.#addEdge(this.#nodeVariable(node.child1), this.#nodeVariable(nodeIndex));
        return;
      case FunctionalCoreTag.LetRec:
        this.#visitExpression(node.child0, [this.#binderVariable(nodeIndex), ...environment]);
        this.#addEdge(this.#nodeVariable(node.child0), this.#binderVariable(nodeIndex));
        this.#visitExpression(node.child1, [this.#binderVariable(nodeIndex), ...environment]);
        this.#addEdge(this.#nodeVariable(node.child1), this.#nodeVariable(nodeIndex));
        return;
      case FunctionalCoreTag.If:
        this.#visitExpression(node.child0, environment);
        this.#visitExpression(node.child1, environment);
        this.#visitExpression(node.child2, environment);
        this.#addEdge(this.#nodeVariable(node.child1), this.#nodeVariable(nodeIndex));
        this.#addEdge(this.#nodeVariable(node.child2), this.#nodeVariable(nodeIndex));
        return;
      case FunctionalCoreTag.Unary:
        this.#visitExpression(node.child0, environment);
        return;
      case FunctionalCoreTag.Binary:
        this.#visitExpression(node.child0, environment);
        this.#visitExpression(node.child1, environment);
        return;
      case FunctionalCoreTag.Case:
        this.#visitExpression(node.child0, environment);
        this.#visitCaseArms(node.child1, environment, nodeIndex);
        return;
      case FunctionalCoreTag.CaseArm:
      case FunctionalCoreTag.PatternBind:
        throw new Error(
          `functional lambda-set analysis found structural core tag ${node.tag} at expression node ${nodeIndex}`,
        );
    }
  }

  #visitApplication(nodeIndex: number): void {
    const constructorApplication = this.#constructorApplication(nodeIndex);
    if (constructorApplication !== undefined) {
      const arity = this.#module.constructorArities[constructorApplication.constructor]!;
      if (constructorApplication.arguments.length < arity) {
        this.#markIncomplete(this.#nodeVariable(nodeIndex));
        return;
      }
      for (const [field, argument] of constructorApplication.arguments.entries()) {
        this.#addEdge(
          this.#nodeVariable(argument),
          this.#constructorField(constructorApplication.constructor, field),
        );
      }
      return;
    }

    const node = this.#node(nodeIndex);
    const application: ApplicationConstraint = {
      callee: this.#nodeVariable(node.child0),
      argument: this.#nodeVariable(node.child1),
      result: this.#nodeVariable(nodeIndex),
      connectedLambdaNodes: new Set<number>(),
    };
    this.#applicationsByCallee[application.callee]!.push(application);
  }

  #visitCaseArms(
    firstArm: number,
    environment: readonly number[],
    caseNode: number,
  ): void {
    let armIndex = firstArm;
    while (armIndex !== FUNCTIONAL_NO_INDEX) {
      const arm = this.#node(armIndex);
      if (arm.tag !== FunctionalCoreTag.CaseArm) {
        throw new Error(
          `functional lambda-set case ${caseNode} links core tag ${arm.tag} at arm node ${armIndex}`,
        );
      }
      const arity = this.#module.constructorArities[arm.payload];
      if (arity === undefined) {
        throw new Error(
          `functional lambda-set case arm ${armIndex} refers to missing constructor ${arm.payload}`,
        );
      }

      let body = arm.child0;
      let armEnvironment = [...environment];
      for (let bindingIndex = 0; bindingIndex < arity; bindingIndex++) {
        const binding = this.#node(body);
        if (binding.tag !== FunctionalCoreTag.PatternBind) {
          throw new Error(
            `functional lambda-set case arm ${armIndex} has ${bindingIndex} bindings before core tag ${binding.tag}; expected ${arity}`,
          );
        }
        const field = arity - bindingIndex - 1;
        this.#addEdge(
          this.#constructorField(arm.payload, field),
          this.#binderVariable(body),
        );
        armEnvironment = [this.#binderVariable(body), ...armEnvironment];
        body = binding.child0;
      }
      this.#visitExpression(body, armEnvironment);
      this.#addEdge(this.#nodeVariable(body), this.#nodeVariable(caseNode));
      armIndex = arm.child1;
    }
  }

  #solve(): void {
    let nextVariable = 0;
    while (nextVariable < this.#workQueue.length) {
      const source = this.#workQueue[nextVariable]!;
      nextVariable += 1;
      this.#queued[source] = false;
      for (const target of this.#edges[source]!) this.#merge(source, target);
      for (const application of this.#applicationsByCallee[source]!) {
        this.#connectApplication(application);
      }
    }
  }

  #connectApplication(application: ApplicationConstraint): void {
    const callee = this.#state(application.callee);
    if (callee.incomplete) this.#markIncomplete(application.result);
    for (const lambdaNode of callee.lambdaNodes) {
      if (application.connectedLambdaNodes.has(lambdaNode)) continue;
      application.connectedLambdaNodes.add(lambdaNode);
      const body = this.#lambdaBodies.get(lambdaNode);
      if (body === undefined) {
        throw new Error(
          `functional lambda-set application reached lambda node ${lambdaNode} without a body`,
        );
      }
      this.#addEdge(application.argument, this.#binderVariable(lambdaNode));
      this.#addEdge(this.#nodeVariable(body), application.result);
    }
  }

  #addEdge(source: number, target: number): void {
    const targets = this.#edges[source]!;
    if (targets.has(target)) return;
    targets.add(target);
    this.#merge(source, target);
  }

  #merge(source: number, target: number): void {
    const sourceState = this.#state(source);
    const targetState = this.#state(target);
    let changed = false;
    if (sourceState.incomplete && !targetState.incomplete) {
      targetState.incomplete = true;
      changed = true;
    }
    if (!targetState.incomplete) {
      for (const lambdaNode of sourceState.lambdaNodes) {
        if (targetState.lambdaNodes.has(lambdaNode)) continue;
        if (targetState.lambdaNodes.size === MAXIMUM_LAMBDA_SET_SIZE) {
          targetState.lambdaNodes.clear();
          targetState.incomplete = true;
          changed = true;
          break;
        }
        targetState.lambdaNodes.add(lambdaNode);
        changed = true;
      }
    }
    if (changed) this.#enqueue(target);
  }

  #addLambda(variable: number, lambdaNode: number): void {
    const state = this.#state(variable);
    if (state.incomplete || state.lambdaNodes.has(lambdaNode)) return;
    if (state.lambdaNodes.size === MAXIMUM_LAMBDA_SET_SIZE) {
      state.lambdaNodes.clear();
      state.incomplete = true;
    } else {
      state.lambdaNodes.add(lambdaNode);
    }
    this.#enqueue(variable);
  }

  #markIncomplete(variable: number): void {
    const state = this.#state(variable);
    if (state.incomplete) return;
    state.incomplete = true;
    this.#enqueue(variable);
  }

  #enqueue(variable: number): void {
    if (this.#queued[variable]) return;
    this.#queued[variable] = true;
    this.#workQueue.push(variable);
  }

  #markEscapingConstructorFieldsIncomplete(): void {
    const parents: ParentEdge[][] = Array.from({ length: this.#nodes.length }, () => []);
    for (const [parentIndex, node] of this.#nodes.entries()) {
      for (
        const [childPosition, childIndex] of [node.child0, node.child1, node.child2].entries()
      ) {
        if (childIndex === FUNCTIONAL_NO_INDEX || childIndex >= this.#nodes.length) continue;
        parents[childIndex]!.push({
          parent: parentIndex,
          child: childPosition as 0 | 1 | 2,
        });
      }
    }

    for (const [nodeIndex, node] of this.#nodes.entries()) {
      if (node.tag !== FunctionalCoreTag.Constructor) continue;
      const arity = this.#module.constructorArities[node.payload];
      if (arity === undefined || arity === 0) continue;
      let appliedArguments = 0;
      let current = nodeIndex;
      while (appliedArguments < arity) {
        const uses = parents[current]!;
        if (uses.length !== 1) break;
        const use = uses[0]!;
        const parent = this.#node(use.parent);
        if (use.child !== 0 || parent.tag !== FunctionalCoreTag.Apply) break;
        appliedArguments += 1;
        current = use.parent;
      }
      if (appliedArguments === arity) continue;
      for (let field = 0; field < arity; field++) {
        this.#markIncomplete(this.#constructorField(node.payload, field));
      }
    }
  }

  #constructorApplication(nodeIndex: number): ConstructorApplication | undefined {
    const reverseArguments: number[] = [];
    let callee = this.#node(nodeIndex);
    while (callee.tag === FunctionalCoreTag.Apply) {
      reverseArguments.push(callee.child1);
      callee = this.#node(callee.child0);
    }
    if (callee.tag !== FunctionalCoreTag.Constructor) return undefined;
    const arity = this.#module.constructorArities[callee.payload];
    if (arity === undefined || reverseArguments.length === 0 || reverseArguments.length > arity) {
      return undefined;
    }
    return {
      constructor: callee.payload,
      arguments: Object.freeze(reverseArguments.reverse()),
    };
  }

  #nodeVariable(nodeIndex: number): number {
    this.#node(nodeIndex);
    return nodeIndex;
  }

  #binderVariable(nodeIndex: number): number {
    this.#node(nodeIndex);
    return this.#binderBase + nodeIndex;
  }

  #definitionVariable(definition: number): number {
    if (definition < 0 || definition >= this.#module.definitionCount) {
      throw new Error(
        `functional lambda-set definition ${definition} is outside ${this.#module.definitionCount} definitions`,
      );
    }
    return this.#definitionBase + definition;
  }

  #constructorField(constructor: number, field: number): number {
    const firstField = this.#constructorFieldOffsets[constructor];
    const endField = this.#constructorFieldOffsets[constructor + 1];
    if (
      firstField === undefined || endField === undefined || field < 0 ||
      firstField + field >= endField
    ) {
      throw new Error(
        `functional lambda-set constructor ${constructor} field ${field} is outside its declared arity`,
      );
    }
    return this.#constructorFieldBase + firstField + field;
  }

  #state(variable: number): FlowState {
    const state = this.#states[variable];
    if (state === undefined) {
      throw new Error(
        `functional lambda-set flow variable ${variable} is outside ${this.#states.length} variables`,
      );
    }
    return state;
  }

  #node(index: number): FunctionalCoreNode {
    const node = this.#nodes[index];
    if (node === undefined) {
      throw new Error(
        `functional lambda-set core node ${index} is outside ${this.#nodes.length} resolved nodes`,
      );
    }
    return node;
  }
}
