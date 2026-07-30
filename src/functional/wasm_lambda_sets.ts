import { CoreTag, NO_INDEX } from "./abi.ts";
import type { CompiledModule, CoreNode } from "./compiler_module.ts";
import { primopDeclaration, PrimopFamily } from "../semantic/primops.ts";
import { type EffectSet, effectSetFrom } from "./effect_set.ts";
import { type HostFieldDeclaration, INIT_CONSTRUCTOR_NAME } from "./host_contract.ts";

// Wider sets retain the ordinary closure path so adversarial modules cannot inflate dispatch code.
const MAXIMUM_LAMBDA_SET_SIZE = 64;

export interface LambdaSet {
  readonly lambdaNodes: readonly number[];
  readonly effects: EffectSet;
  readonly complete: boolean;
}

interface FlowState {
  lambdaNodes: Set<number> | undefined;
  effectNames: Set<string> | undefined;
  incomplete: boolean;
}

interface ApplicationConstraint {
  readonly callee: number;
  readonly arguments: readonly number[];
  readonly result: number;
  readonly connectedLambdaNodes: Set<number>;
}

interface ParentEdge {
  readonly parent: number;
  readonly child: number;
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
export class LambdaSetAnalysis {
  readonly #module: CompiledModule;
  readonly #nodes: readonly CoreNode[];
  readonly #representation: "core" | "wasm";
  readonly #states: FlowState[];
  readonly #edges: (Set<number> | undefined)[];
  readonly #applicationsByCallee: (ApplicationConstraint[] | undefined)[];
  readonly #lambdaBodies = new Map<number, number>();
  readonly #constructorFieldOffsets: readonly number[];
  readonly #binderBase: number;
  readonly #parameterBinderBase: number;
  readonly #caseBinderBase: number;
  readonly #definitionBase: number;
  readonly #constructorFieldBase: number;
  readonly #externalValue: number;
  readonly #workQueue: number[] = [];
  readonly #queued: boolean[];
  readonly #lambdaSets: (LambdaSet | undefined)[];

  static forCore(module: CompiledModule, nodes: readonly CoreNode[]): LambdaSetAnalysis {
    return new LambdaSetAnalysis(module, nodes, "core");
  }

  static forWasm(module: CompiledModule, nodes: readonly CoreNode[]): LambdaSetAnalysis {
    return new LambdaSetAnalysis(module, nodes, "wasm");
  }

  private constructor(
    module: CompiledModule,
    nodes: readonly CoreNode[],
    representation: "core" | "wasm",
  ) {
    this.#module = module;
    this.#nodes = nodes;
    this.#representation = representation;
    this.#binderBase = nodes.length;
    this.#parameterBinderBase = this.#binderBase + nodes.length;
    this.#caseBinderBase = this.#parameterBinderBase + module.parameterCount;
    this.#definitionBase = this.#caseBinderBase + module.caseBinderCount;
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
      () => ({ lambdaNodes: undefined, effectNames: undefined, incomplete: false }),
    );
    this.#edges = Array.from({ length: flowVariableCount }, () => undefined);
    this.#applicationsByCallee = Array.from({ length: flowVariableCount }, () => undefined);
    this.#queued = Array.from({ length: flowVariableCount }, () => false);
    this.#lambdaSets = Array.from({ length: nodes.length }, () => undefined);

    this.#markIncomplete(this.#externalValue);
    this.#markEscapingConstructorFieldsIncomplete();
    for (const [constructor, name] of module.constructorNames.entries()) {
      if (name !== INIT_CONSTRUCTOR_NAME) continue;
      const arity = module.constructorArities[constructor]!;
      const hostFields = module.hostCapabilities.flatMap((capability) => capability.fields);
      if (arity !== hostFields.length) {
        throw new Error(
          `functional lambda-set init constructor ${constructor} has arity ${arity}; expected ${hostFields.length} host fields`,
        );
      }
      for (let field = 0; field < arity; field++) {
        this.#markIncomplete(this.#constructorField(constructor, field));
        const declaration = hostFields[field];
        if (declaration?.kind === "operation") {
          this.#addEffects(this.#constructorField(constructor, field), declaration.effects);
        }
      }
    }

    const hostFieldsByDefinition = new Map<number, HostFieldDeclaration>();
    for (const binding of module.hostDefinitions) {
      const definition = module.definitionNames.indexOf(binding.definition);
      const capability = module.hostCapabilities.find((candidate) =>
        candidate.name === binding.capability
      );
      const field = capability?.fields.find((candidate) => candidate.name === binding.field);
      if (definition < 0 || field === undefined) {
        throw new Error(
          `functional lambda-set host definition ${
            JSON.stringify(binding.definition)
          } could not resolve ${JSON.stringify(`${binding.capability}.${binding.field}`)}`,
        );
      }
      hostFieldsByDefinition.set(definition, field);
    }
    for (const [definition, root] of module.definitionRoots.entries()) {
      const hostField = hostFieldsByDefinition.get(definition);
      if (hostField !== undefined) {
        this.#markIncomplete(this.#definitionVariable(definition));
        if (hostField.kind === "operation") {
          this.#addEffects(this.#definitionVariable(definition), hostField.effects);
        }
        continue;
      }
      this.#visitExpression(root, []);
      this.#addEdge(this.#nodeVariable(root), this.#definitionVariable(definition));
      let effectVariable = this.#definitionVariable(definition);
      let functionNode = root;
      while (true) {
        const node = this.#node(functionNode);
        if (node.tag !== CoreTag.Lambda) break;
        effectVariable = this.#nodeVariable(functionNode);
        functionNode = node.child0;
      }
      this.#addEffects(
        effectVariable,
        module.declaredDefinitionEffects[definition]!,
      );
    }

    const entryApplication: ApplicationConstraint = {
      callee: this.#definitionVariable(module.entryDefinition),
      arguments: [this.#externalValue],
      result: this.#externalValue,
      connectedLambdaNodes: new Set<number>(),
    };
    this.#applicationsByCallee[entryApplication.callee] = [entryApplication];
    this.#enqueue(entryApplication.callee);
    this.#solve();
  }

  lambdaSet(nodeIndex: number): LambdaSet {
    const cached = this.#lambdaSets[nodeIndex];
    if (cached !== undefined) return cached;
    const state = this.#state(this.#nodeVariable(nodeIndex));
    const lambdaNodes = state.lambdaNodes ?? [];
    const lambdaSet = Object.freeze({
      lambdaNodes: Object.freeze([...lambdaNodes].sort((left, right) => left - right)),
      effects: effectSetFrom(state.effectNames ?? []),
      complete: !state.incomplete,
    });
    this.#lambdaSets[nodeIndex] = lambdaSet;
    return lambdaSet;
  }

  forEachLambdaSetMember(
    nodeIndex: number,
    visitLambda: (lambdaNode: number) => void,
    visitEffect: (effect: string) => void,
  ): void {
    const state = this.#state(this.#nodeVariable(nodeIndex));
    for (const lambdaNode of state.lambdaNodes ?? []) visitLambda(lambdaNode);
    for (const effect of state.effectNames ?? []) visitEffect(effect);
  }

  #visitExpression(nodeIndex: number, environment: number[]): void {
    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.StoreEmpty:
        return;
      case CoreTag.Local: {
        const binding = environment[environment.length - node.payload - 1];
        if (binding === undefined) {
          throw new Error(
            `functional lambda-set local depth ${node.payload} at node ${nodeIndex} exceeds environment depth ${environment.length}`,
          );
        }
        this.#addEdge(binding, this.#nodeVariable(nodeIndex));
        return;
      }
      case CoreTag.Global:
        if (node.payload >= this.#module.definitionCount) {
          throw new Error(
            `functional lambda-set global d${node.payload} at node ${nodeIndex} exceeds ${this.#module.definitionCount} definitions`,
          );
        }
        this.#addEdge(this.#definitionVariable(node.payload), this.#nodeVariable(nodeIndex));
        return;
      case CoreTag.Constructor:
        if (this.#module.constructorArities[node.payload] === undefined) {
          throw new Error(
            `functional lambda-set constructor ${node.payload} at node ${nodeIndex} exceeds ${this.#module.constructorCount} constructors`,
          );
        } else if (this.#module.constructorArities[node.payload]! > 0) {
          this.#markIncomplete(this.#nodeVariable(nodeIndex));
        }
        return;
      case CoreTag.Lambda: {
        this.#addLambda(this.#nodeVariable(nodeIndex), nodeIndex);
        this.#lambdaBodies.set(nodeIndex, node.child0);
        if (this.#representation === "wasm") {
          environment.push(this.#binderVariable(nodeIndex));
        } else {
          for (let parameter = 0; parameter < node.child1; parameter++) {
            environment.push(this.#parameterBinder(node.payload + parameter));
          }
        }
        this.#visitExpression(node.child0, environment);
        environment.length -= this.#representation === "wasm" ? 1 : node.child1;
        return;
      }
      case CoreTag.Apply: {
        this.#visitExpression(node.child0, environment);
        const arguments_ = this.#applicationArguments(node);
        for (const argument of arguments_) this.#visitExpression(argument, environment);
        this.#visitApplication(nodeIndex);
        return;
      }
      case CoreTag.Prim: {
        if (this.#representation === "wasm") {
          throw new Error(
            `functional lambda-set analysis found unlowered primop at expression node ${nodeIndex}`,
          );
        }
        for (let operand = node.child0; operand < node.child0 + node.child1; operand++) {
          this.#visitExpression(this.#module.arguments[operand]!.node, environment);
        }
        if (primopDeclaration(node.payload)?.family === PrimopFamily.StoreRead) {
          this.#markIncomplete(this.#nodeVariable(nodeIndex));
        }
        return;
      }
      case CoreTag.Let:
        this.#visitExpression(node.child0, environment);
        this.#addEdge(this.#nodeVariable(node.child0), this.#binderVariable(nodeIndex));
        environment.push(this.#binderVariable(nodeIndex));
        this.#visitExpression(node.child1, environment);
        environment.pop();
        this.#addEdge(this.#nodeVariable(node.child1), this.#nodeVariable(nodeIndex));
        return;
      case CoreTag.LetRec:
        environment.push(this.#binderVariable(nodeIndex));
        this.#visitExpression(node.child0, environment);
        this.#addEdge(this.#nodeVariable(node.child0), this.#binderVariable(nodeIndex));
        this.#visitExpression(node.child1, environment);
        environment.pop();
        this.#addEdge(this.#nodeVariable(node.child1), this.#nodeVariable(nodeIndex));
        return;
      case CoreTag.If:
        this.#visitExpression(node.child0, environment);
        this.#visitExpression(node.child1, environment);
        this.#visitExpression(node.child2, environment);
        this.#addEdge(this.#nodeVariable(node.child1), this.#nodeVariable(nodeIndex));
        this.#addEdge(this.#nodeVariable(node.child2), this.#nodeVariable(nodeIndex));
        return;
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
        this.#visitExpression(node.child0, environment);
        return;
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
        this.#visitExpression(node.child0, environment);
        this.#visitExpression(node.child1, environment);
        return;
      case CoreTag.StoreRead:
        this.#visitExpression(node.child0, environment);
        this.#visitExpression(node.child1, environment);
        this.#markIncomplete(this.#nodeVariable(nodeIndex));
        return;
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
        this.#visitExpression(node.child0, environment);
        this.#visitExpression(node.child1, environment);
        this.#visitExpression(node.child2, environment);
        return;
      case CoreTag.Case:
        this.#visitExpression(node.child0, environment);
        if (this.#representation === "wasm") {
          this.#visitCaseArms(node.child1, environment, nodeIndex);
        } else {
          this.#visitCaseAlternatives(node.payload, node.child1, environment, nodeIndex);
        }
        return;
      case CoreTag.CaseArm:
      case CoreTag.PatternBind:
        if (this.#representation === "wasm") {
          throw new Error(
            `functional lambda-set analysis found structural core tag ${node.tag} at expression node ${nodeIndex}`,
          );
        }
        throw new Error(
          `functional lambda-set analysis found legacy core tag ${node.tag} at expression node ${nodeIndex}`,
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
      arguments: this.#applicationArguments(node).map((argument) => this.#nodeVariable(argument)),
      result: this.#nodeVariable(nodeIndex),
      connectedLambdaNodes: new Set<number>(),
    };
    const applications = this.#applicationsByCallee[application.callee];
    if (applications === undefined) {
      this.#applicationsByCallee[application.callee] = [application];
    } else {
      applications.push(application);
    }
  }

  #visitCaseArms(
    firstArm: number,
    environment: number[],
    caseNode: number,
  ): void {
    let armIndex = firstArm;
    while (armIndex !== NO_INDEX) {
      const arm = this.#node(armIndex);
      if (arm.tag !== CoreTag.CaseArm) {
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
      const outerEnvironmentDepth = environment.length;
      for (let bindingIndex = 0; bindingIndex < arity; bindingIndex++) {
        const binding = this.#node(body);
        if (binding.tag !== CoreTag.PatternBind) {
          throw new Error(
            `functional lambda-set case arm ${armIndex} has ${bindingIndex} bindings before core tag ${binding.tag}; expected ${arity}`,
          );
        }
        const field = arity - bindingIndex - 1;
        this.#addEdge(
          this.#constructorField(arm.payload, field),
          this.#binderVariable(body),
        );
        environment.push(this.#binderVariable(body));
        body = binding.child0;
      }
      this.#visitExpression(body, environment);
      environment.length = outerEnvironmentDepth;
      this.#addEdge(this.#nodeVariable(body), this.#nodeVariable(caseNode));
      armIndex = arm.child1;
    }
  }

  #visitCaseAlternatives(
    firstAlternative: number,
    alternativeCount: number,
    environment: number[],
    caseNode: number,
  ): void {
    for (let offset = 0; offset < alternativeCount; offset++) {
      const alternativeIndex = firstAlternative + offset;
      const alternative = this.#module.caseAlternatives[alternativeIndex];
      if (alternative === undefined) {
        throw new Error(
          `functional lambda-set case ${caseNode} references missing alternative ${alternativeIndex}`,
        );
      }
      const arity = this.#module.constructorArities[alternative.constructor];
      if (arity === undefined) {
        throw new Error(
          `functional lambda-set case alternative ${alternativeIndex} refers to missing constructor ${alternative.constructor}`,
        );
      }

      const outerEnvironmentDepth = environment.length;
      for (let bindingIndex = arity - 1; bindingIndex >= 0; bindingIndex--) {
        this.#addEdge(
          this.#constructorField(alternative.constructor, bindingIndex),
          this.#caseBinder(alternative.firstBinder + bindingIndex),
        );
        environment.push(this.#caseBinder(alternative.firstBinder + bindingIndex));
      }
      this.#visitExpression(alternative.body, environment);
      environment.length = outerEnvironmentDepth;
      this.#addEdge(this.#nodeVariable(alternative.body), this.#nodeVariable(caseNode));
    }
  }

  #solve(): void {
    let nextVariable = 0;
    while (nextVariable < this.#workQueue.length) {
      const source = this.#workQueue[nextVariable]!;
      nextVariable += 1;
      this.#queued[source] = false;
      for (const target of this.#edges[source] ?? []) this.#merge(source, target);
      for (const application of this.#applicationsByCallee[source] ?? []) {
        this.#connectApplication(application);
      }
    }
  }

  #connectApplication(application: ApplicationConstraint): void {
    const callee = this.#state(application.callee);
    if (callee.incomplete) this.#markIncomplete(application.result);
    for (const lambdaNode of callee.lambdaNodes ?? []) {
      if (application.connectedLambdaNodes.has(lambdaNode)) continue;
      application.connectedLambdaNodes.add(lambdaNode);
      const body = this.#lambdaBodies.get(lambdaNode);
      if (body === undefined) {
        throw new Error(
          `functional lambda-set application reached lambda node ${lambdaNode} without a body`,
        );
      }
      if (this.#representation === "wasm") {
        this.#addEdge(application.arguments[0]!, this.#binderVariable(lambdaNode));
      } else {
        const lambda = this.#node(lambdaNode);
        if (application.arguments.length !== lambda.child1) {
          this.#markIncomplete(application.result);
          continue;
        }
        for (const [parameter, argument] of application.arguments.entries()) {
          this.#addEdge(argument, this.#parameterBinder(lambda.payload + parameter));
        }
      }
      this.#addEdge(this.#nodeVariable(body), application.result);
    }
  }

  #addEdge(source: number, target: number): void {
    let targets = this.#edges[source];
    if (targets === undefined) {
      targets = new Set<number>();
      this.#edges[source] = targets;
    }
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
    if (!targetState.incomplete && sourceState.lambdaNodes !== undefined) {
      for (const lambdaNode of sourceState.lambdaNodes) {
        if (targetState.lambdaNodes?.has(lambdaNode)) continue;
        if (targetState.lambdaNodes?.size === MAXIMUM_LAMBDA_SET_SIZE) {
          targetState.lambdaNodes = undefined;
          targetState.incomplete = true;
          changed = true;
          break;
        }
        targetState.lambdaNodes ??= new Set<number>();
        targetState.lambdaNodes.add(lambdaNode);
        changed = true;
      }
    }
    if (sourceState.effectNames !== undefined) {
      for (const effect of sourceState.effectNames) {
        if (targetState.effectNames?.has(effect)) continue;
        targetState.effectNames ??= new Set<string>();
        targetState.effectNames.add(effect);
        changed = true;
      }
    }
    if (changed) this.#enqueue(target);
  }

  #addEffects(variable: number, effects: EffectSet): void {
    const state = this.#state(variable);
    let changed = false;
    for (const effect of effects) {
      if (state.effectNames?.has(effect)) continue;
      state.effectNames ??= new Set<string>();
      state.effectNames.add(effect);
      changed = true;
    }
    if (changed) this.#enqueue(variable);
  }

  #addLambda(variable: number, lambdaNode: number): void {
    const state = this.#state(variable);
    if (state.incomplete || state.lambdaNodes?.has(lambdaNode)) return;
    if (state.lambdaNodes?.size === MAXIMUM_LAMBDA_SET_SIZE) {
      state.lambdaNodes = undefined;
      state.incomplete = true;
    } else {
      state.lambdaNodes ??= new Set<number>();
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
      const childReferences = node.tag === CoreTag.Apply
        ? [node.child0, ...this.#applicationArguments(node)]
        : [node.child0, node.child1, node.child2];
      for (const [childPosition, childIndex] of childReferences.entries()) {
        if (childIndex === NO_INDEX || childIndex >= this.#nodes.length) continue;
        parents[childIndex]!.push({
          parent: parentIndex,
          child: childPosition,
        });
      }
    }

    for (const [nodeIndex, node] of this.#nodes.entries()) {
      if (node.tag !== CoreTag.Constructor) continue;
      const arity = this.#module.constructorArities[node.payload];
      if (arity === undefined || arity === 0) continue;
      let appliedArguments = 0;
      let current = nodeIndex;
      while (appliedArguments < arity) {
        const uses = parents[current]!;
        if (uses.length !== 1) break;
        const use = uses[0]!;
        const parent = this.#node(use.parent);
        if (use.child !== 0 || parent.tag !== CoreTag.Apply) break;
        appliedArguments += this.#representation === "wasm" ? 1 : parent.child1;
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
    while (callee.tag === CoreTag.Apply) {
      reverseArguments.push(...this.#applicationArguments(callee).reverse());
      callee = this.#node(callee.child0);
    }
    if (callee.tag !== CoreTag.Constructor) return undefined;
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

  #parameterBinder(parameter: number): number {
    if (parameter < 0 || parameter >= this.#module.parameterCount) {
      throw new Error(
        `functional lambda-set parameter ${parameter} is outside ${this.#module.parameterCount} parameters`,
      );
    }
    return this.#parameterBinderBase + parameter;
  }

  #caseBinder(binder: number): number {
    if (binder < 0 || binder >= this.#module.caseBinderCount) {
      throw new Error(
        `functional lambda-set case binder ${binder} is outside ${this.#module.caseBinderCount} binders`,
      );
    }
    return this.#caseBinderBase + binder;
  }

  #applicationArguments(node: CoreNode): number[] {
    if (this.#representation === "wasm") return [node.child1];
    return Array.from(
      { length: node.child1 },
      (_, offset) => this.#module.arguments[node.payload + offset]!.node,
    );
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

  #node(index: number): CoreNode {
    const node = this.#nodes[index];
    if (node === undefined) {
      throw new Error(
        `functional lambda-set core node ${index} is outside ${this.#nodes.length} resolved nodes`,
      );
    }
    return node;
  }
}
