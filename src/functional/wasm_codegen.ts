import {
  FUNCTIONAL_NO_INDEX,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalCoreTag,
  type FunctionalType,
  FunctionalUnaryOperator,
} from "./abi.ts";
import type { FunctionalCoreNode, GpuFunctionalModule } from "./compiler_module.ts";
import {
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_INIT_TYPE_NAME,
  type FunctionalHostCapabilityDeclaration,
  type FunctionalHostFieldDeclaration,
  type FunctionalHostScalarType,
  type FunctionalWasmHostValue,
  type FunctionalWasmInit,
  type FunctionalWasmInitBinding,
} from "./host_contract.ts";
import {
  encodeWasmModule,
  type WasmFunctionBody,
  type WasmFunctionImport,
  WasmInstructions,
  WasmValueType,
} from "./wasm_binary.ts";
import { FunctionalWasmCaptureAnalysis } from "./wasm_capture_analysis.ts";
import { FunctionalLambdaSetAnalysis } from "./wasm_lambda_sets.ts";

const HOST_IMPORT_MODULE_PREFIX = "functional_init:";
const CLOSURE_OBJECT_KIND = 1;
const CONSTRUCTOR_OBJECT_KIND = 2;
const THUNK_OBJECT_KIND = 3;
const THUNK_UNEVALUATED = 0;
const THUNK_EVALUATING = 1;
const THUNK_EVALUATED = 2;
const OBJECT_HEADER_BYTE_LENGTH = 16;
const THUNK_HEADER_BYTE_LENGTH = 24;
const VALUE_BYTE_LENGTH = 8;
// Specialization is optional for correctness; this cap bounds generated code for recursive input.
const MAXIMUM_SPECIALIZED_INLINE_SITES = 512;

type ValueSource =
  | { readonly kind: "i64-local"; readonly index: number }
  | { readonly kind: "i32-pointer"; readonly index: number }
  | { readonly kind: "capture"; readonly byteOffset: number };

interface VirtualLambda {
  readonly kind: "virtual-lambda";
  readonly node: number;
  readonly environment: FunctionalEnvironment;
}

type FunctionalBinding = ValueSource | VirtualLambda;

// A missing source preserves de Bruijn depth for a binding that this closure does not capture.
type FunctionalEnvironment = readonly (FunctionalBinding | undefined)[];

interface HostField {
  readonly capability: string;
  readonly declaration: FunctionalHostFieldDeclaration;
  readonly importIndex: number;
  readonly closureSlot?: number;
}

interface FunctionalWasmEntry {
  readonly takesInit: boolean;
  readonly result: FunctionalHostScalarType;
}

interface ConstructorApplication {
  readonly constructorIndex: number;
  readonly argumentNodes: readonly number[];
}

export type FunctionalWasmValue = FunctionalWasmHostValue;

export interface FunctionalWasmStats {
  readonly thunkEvaluations: number;
  readonly allocatedBytes: number;
  readonly specializedCallSites: number;
}

export interface FunctionalWasmExecution {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly instance: WebAssembly.Instance;
  readonly value: FunctionalWasmValue;
  readonly stats: FunctionalWasmStats;
}

export interface FunctionalWasmRunOptions {
  readonly init?: FunctionalWasmInit;
}

export class FunctionalWasmRuntimeError extends Error {
  readonly kind: "blackhole";
  readonly entryDefinition: number;

  constructor(entryDefinition: number, cause: unknown) {
    super(
      `functional WASM entry d${entryDefinition} recursively forced an evaluating thunk`,
      { cause },
    );
    this.name = "FunctionalWasmRuntimeError";
    this.kind = "blackhole";
    this.entryDefinition = entryDefinition;
  }
}

export async function compileFunctionalModuleToWasm(
  module: GpuFunctionalModule,
): Promise<Uint8Array<ArrayBuffer>> {
  functionalWasmEntry(module);
  const nodes = await module.readCoreNodes();
  return new FunctionalWasmCompiler(module, nodes).compile();
}

export async function runFunctionalWasmModule(
  module: GpuFunctionalModule,
  options: FunctionalWasmRunOptions = {},
): Promise<FunctionalWasmExecution> {
  const entry = functionalWasmEntry(module);
  const bytes = await compileFunctionalModuleToWasm(module);
  const imports = functionalWasmImports(module.hostCapabilities, options.init);
  const instantiated = await WebAssembly.instantiate(bytes, imports);
  const exportedMain = instantiated.instance.exports.main;
  if (typeof exportedMain !== "function") {
    throw new Error(
      `functional WASM entry d${module.entryDefinition} did not export a callable main function`,
    );
  }
  const heapTop = instantiated.instance.exports.heapTop;
  if (!(heapTop instanceof WebAssembly.Global)) {
    throw new Error(
      `functional WASM entry d${module.entryDefinition} did not export its allocator heap top`,
    );
  }
  const heapBase = Number(heapTop.value) >>> 0;
  let result: number;
  try {
    result = exportedMain() as number;
  } catch (cause) {
    const runtimeFault = instantiated.instance.exports.runtimeFault;
    if (runtimeFault instanceof WebAssembly.Global && runtimeFault.value === 1) {
      throw new FunctionalWasmRuntimeError(module.entryDefinition, cause);
    }
    throw cause;
  }
  const value: FunctionalWasmValue = entry.result.kind === "integer"
    ? { kind: "integer", value: result }
    : entry.result.kind === "boolean"
    ? { kind: "boolean", value: result !== 0 }
    : { kind: "unit" };
  const thunkEvaluations = instantiated.instance.exports.thunkEvaluations;
  if (!(thunkEvaluations instanceof WebAssembly.Global)) {
    throw new Error(
      `functional WASM entry d${module.entryDefinition} did not export thunk evaluation stats`,
    );
  }
  const specializedCallSites = instantiated.instance.exports.specializedCallSites;
  if (!(specializedCallSites instanceof WebAssembly.Global)) {
    throw new Error(
      `functional WASM entry d${module.entryDefinition} did not export lambda-set specialization stats`,
    );
  }
  const finalHeapTop = Number(heapTop.value) >>> 0;
  if (finalHeapTop < heapBase) {
    throw new Error(
      `functional WASM entry d${module.entryDefinition} wrapped its allocator heap top from ${heapBase} to ${finalHeapTop}`,
    );
  }
  return {
    bytes,
    instance: instantiated.instance,
    value,
    stats: {
      thunkEvaluations: Number(thunkEvaluations.value),
      allocatedBytes: finalHeapTop - heapBase,
      specializedCallSites: Number(specializedCallSites.value),
    },
  };
}

class FunctionalWasmCompiler {
  readonly #module: GpuFunctionalModule;
  readonly #nodes: readonly FunctionalCoreNode[];
  readonly #captureAnalysis: FunctionalWasmCaptureAnalysis;
  readonly #lambdaSetAnalysis: FunctionalLambdaSetAnalysis;
  readonly #indirectFunctions: (WasmFunctionBody | undefined)[] = [];
  readonly #lambdaSlots: (number | undefined)[];
  readonly #recursiveLambdaOwners = new Map<number, number>();
  readonly #constructorClosureSlots: (number | undefined)[][];
  readonly #nullaryConstructorOffsets: readonly (number | undefined)[];
  readonly #globalThunkSlots: readonly (number | undefined)[];
  readonly #entry: FunctionalWasmEntry;
  readonly #hostFields: readonly HostField[];
  readonly #functionImports: readonly WasmFunctionImport[];
  readonly #activeSpecializedLambdas = new Set<number>();
  #remainingSpecializedInlineSites = MAXIMUM_SPECIALIZED_INLINE_SITES;
  #specializedCallSiteCount = 0;

  constructor(module: GpuFunctionalModule, nodes: readonly FunctionalCoreNode[]) {
    this.#module = module;
    this.#nodes = nodes;
    this.#captureAnalysis = new FunctionalWasmCaptureAnalysis(nodes);
    this.#lambdaSetAnalysis = new FunctionalLambdaSetAnalysis(module, nodes);
    this.#lambdaSlots = Array.from({ length: nodes.length }, () => undefined);
    for (const [nodeIndex, node] of nodes.entries()) {
      if (node.tag === FunctionalCoreTag.LetRec) {
        this.#recursiveLambdaOwners.set(node.child0, nodeIndex);
      }
    }
    this.#entry = functionalWasmEntry(module);
    const hostFields: HostField[] = [];
    const functionImports: WasmFunctionImport[] = [];
    for (const capability of module.hostCapabilities) {
      for (const declaration of capability.fields) {
        const importIndex = functionImports.length;
        functionImports.push({
          module: hostImportModule(capability.name),
          name: declaration.name,
          typeIndex: declaration.kind === "value" ? 3 : 0,
        });
        hostFields.push({
          capability: capability.name,
          declaration,
          importIndex,
          ...(declaration.kind === "operation"
            ? { closureSlot: this.reserveIndirectFunction() }
            : {}),
        });
      }
    }
    this.#hostFields = Object.freeze(hostFields);
    this.#functionImports = Object.freeze(functionImports);
    this.#constructorClosureSlots = module.constructorArities.map((arity) =>
      Array.from({ length: arity }, () => undefined)
    );
    const referencedNullaryConstructors = new Set<number>();
    for (const node of nodes) {
      if (
        node.tag === FunctionalCoreTag.Constructor &&
        module.constructorArities[node.payload] === 0
      ) {
        referencedNullaryConstructors.add(node.payload);
      }
    }
    if (
      hostFields.some((field) =>
        field.declaration.kind === "value"
          ? field.declaration.type.kind === "unit"
          : field.declaration.result.kind === "unit"
      )
    ) {
      const unitConstructor = module.constructorNames.indexOf(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME);
      if (unitConstructor >= 0) referencedNullaryConstructors.add(unitConstructor);
    }
    let nullaryConstructorOffset = module.definitionCount * VALUE_BYTE_LENGTH;
    this.#nullaryConstructorOffsets = module.constructorArities.map((arity, constructorIndex) => {
      if (arity !== 0 || !referencedNullaryConstructors.has(constructorIndex)) return undefined;
      const offset = nullaryConstructorOffset;
      nullaryConstructorOffset += VALUE_BYTE_LENGTH;
      return offset;
    });
    this.#globalThunkSlots = module.definitionRoots.map((rootNode) =>
      this.expressionIsWhnf(rootNode) ? undefined : this.reserveIndirectFunction()
    );
  }

  compile(): Uint8Array<ArrayBuffer> {
    this.compileHostOperationClosures();
    this.compileGlobalThunks();
    const entryInstructions = new WasmInstructions(0);
    this.emitGlobalInitialization(entryInstructions);
    this.emitEntryCall(entryInstructions);
    if (this.#entry.result.kind === "unit") {
      entryInstructions.emit(0x1a);
      entryInstructions.i32Const(0);
    } else {
      entryInstructions.i64Const(3n);
      entryInstructions.emit(0x87, 0xa7);
    }
    const indirectFunctions = this.#indirectFunctions.map((body, slot) => {
      if (body === undefined) {
        throw new Error(`functional WASM indirect function slot ${slot} was not emitted`);
      }
      return body;
    });
    const functions = [
      allocateFunction(),
      forceThunkFunction(),
      ...indirectFunctions,
      functionBody(3, entryInstructions, "entry wrapper"),
    ];
    const indirectFunctionIndices = indirectFunctions.map((_, slot) =>
      this.indirectFunctionOffset() + slot
    );
    return encodeWasmModule(
      this.#functionImports,
      functions,
      indirectFunctionIndices,
      this.#functionImports.length + functions.length - 1,
      this.heapStart(),
      this.#specializedCallSiteCount,
    );
  }

  compileHostOperationClosures(): void {
    for (const field of this.#hostFields) {
      if (field.declaration.kind !== "operation" || field.closureSlot === undefined) continue;
      const instructions = new WasmInstructions(2);
      instructions.localGet(1);
      this.emitForceValue(instructions);
      this.emitHostArgument(instructions, field.declaration.parameter);
      instructions.call(field.importIndex);
      this.emitHostResult(instructions, field.declaration.result);
      this.#indirectFunctions[field.closureSlot] = functionBody(
        2,
        instructions,
        `host operation ${hostFieldKey(field.capability, field.declaration.name)}`,
      );
    }
  }

  emitEntryCall(instructions: WasmInstructions): void {
    this.emitGlobalReference(instructions, this.#module.entryDefinition);
    if (!this.#entry.takesInit) return;
    instructions.emit(0xa7);
    const closure = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(closure);
    instructions.localGet(closure);
    this.emitHostInit(instructions);
    instructions.localGet(closure);
    instructions.i32Load(4);
    instructions.emit(0x11);
    instructions.unsigned(2);
    instructions.unsigned(0);
  }

  emitHostInit(instructions: WasmInstructions): void {
    const constructorIndex = this.#module.constructorNames.indexOf(
      FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
    );
    if (constructorIndex < 0) {
      throw new Error(
        `functional WASM entry d${this.#module.entryDefinition} accepts ${FUNCTIONAL_INIT_TYPE_NAME} but the module omits constructor ${FUNCTIONAL_INIT_CONSTRUCTOR_NAME}`,
      );
    }
    const fields: ValueSource[] = [];
    for (const field of this.#hostFields) {
      if (field.declaration.kind === "value") {
        instructions.call(field.importIndex);
        this.emitHostResult(instructions, field.declaration.type);
      } else {
        if (field.closureSlot === undefined) {
          throw new Error(
            `functional WASM host operation ${
              hostFieldKey(field.capability, field.declaration.name)
            } omitted its closure slot`,
          );
        }
        this.emitClosure(instructions, field.closureSlot, []);
      }
      const value = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(value);
      fields.push({ kind: "i64-local", index: value });
    }
    this.emitConstructor(instructions, constructorIndex, fields);
  }

  compileGlobalThunks(): void {
    for (const [definitionIndex, slot] of this.#globalThunkSlots.entries()) {
      if (slot === undefined) continue;
      const instructions = new WasmInstructions(1);
      this.compileExpression(instructions, this.#module.definitionRoots[definitionIndex]!, []);
      this.#indirectFunctions[slot] = functionBody(
        4,
        instructions,
        `global thunk d${definitionIndex}`,
      );
    }
  }

  emitGlobalInitialization(instructions: WasmInstructions): void {
    instructions.i32Const(0);
    instructions.i64Load(0);
    instructions.emit(0x50, 0x04, 0x40);
    for (const [constructorIndex, offset] of this.#nullaryConstructorOffsets.entries()) {
      if (offset === undefined) continue;
      instructions.i32Const(offset);
      this.emitConstructor(instructions, constructorIndex, []);
      instructions.i64Store(0);
    }
    for (const [definitionIndex, rootNode] of this.#module.definitionRoots.entries()) {
      instructions.i32Const(definitionIndex * VALUE_BYTE_LENGTH);
      const slot = this.#globalThunkSlots[definitionIndex];
      if (slot === undefined) {
        this.compileExpression(instructions, rootNode, []);
      } else {
        this.emitThunkObject(instructions, slot, []);
      }
      instructions.i64Store(0);
    }
    instructions.emit(0x0b);
  }

  emitGlobalReference(instructions: WasmInstructions, definitionIndex: number): void {
    instructions.i32Const(definitionIndex * VALUE_BYTE_LENGTH);
    instructions.i64Load(0);
    this.emitForceValue(instructions);
  }

  heapStart(): number {
    const nullaryConstructorCount =
      this.#nullaryConstructorOffsets.filter((offset) => offset !== undefined).length;
    const globalByteLength = (this.#module.definitionCount + nullaryConstructorCount) *
      VALUE_BYTE_LENGTH;
    return Math.max(1_024, Math.ceil(globalByteLength / VALUE_BYTE_LENGTH) * VALUE_BYTE_LENGTH);
  }

  compileExpression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): void {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
        instructions.i64Const((BigInt(node.payload | 0) << 3n) | 1n);
        return;
      case FunctionalCoreTag.Boolean:
        instructions.i64Const((BigInt(node.payload) << 3n) | 2n);
        return;
      case FunctionalCoreTag.Local:
        this.emitBinding(instructions, this.localSource(environment, node.payload, nodeIndex));
        this.emitForceValue(instructions);
        return;
      case FunctionalCoreTag.Global:
        if (node.payload >= this.#module.definitionCount) {
          throw new Error(
            `functional WASM global d${node.payload} at core node ${nodeIndex} exceeds ${this.#module.definitionCount} definitions`,
          );
        }
        this.emitGlobalReference(instructions, node.payload);
        return;
      case FunctionalCoreTag.Constructor:
        this.compileConstructorReference(instructions, node.payload, nodeIndex);
        return;
      case FunctionalCoreTag.Lambda:
        this.compileLambda(instructions, nodeIndex, environment);
        return;
      case FunctionalCoreTag.Apply:
        this.compileApply(instructions, node, environment, nodeIndex);
        return;
      case FunctionalCoreTag.Let:
        this.compileLet(instructions, node, environment);
        return;
      case FunctionalCoreTag.LetRec:
        this.compileLetRec(instructions, node, environment, nodeIndex);
        return;
      case FunctionalCoreTag.If:
        this.compileIf(instructions, node, environment);
        return;
      case FunctionalCoreTag.Unary:
        this.compileUnary(instructions, node, environment, nodeIndex);
        return;
      case FunctionalCoreTag.Binary:
        this.compileBinary(instructions, node, environment, nodeIndex);
        return;
      case FunctionalCoreTag.Case:
        this.compileCase(instructions, node, environment, nodeIndex);
        return;
      case FunctionalCoreTag.CaseArm:
      case FunctionalCoreTag.PatternBind:
        throw new Error(
          `functional WASM core node ${nodeIndex} has structural tag ${node.tag} in expression position`,
        );
    }
  }

  compileConstructorReference(
    instructions: WasmInstructions,
    constructorIndex: number,
    nodeIndex: number,
  ): void {
    const arity = this.#module.constructorArities[constructorIndex];
    if (arity === undefined) {
      throw new Error(
        `functional WASM constructor ${constructorIndex} at core node ${nodeIndex} exceeds ${this.#module.constructorCount} constructors`,
      );
    }
    if (arity === 0) {
      const offset = this.#nullaryConstructorOffsets[constructorIndex];
      if (offset === undefined) {
        throw new Error(
          `functional WASM nullary constructor ${constructorIndex} at core node ${nodeIndex} omitted its shared value slot`,
        );
      }
      instructions.i32Const(offset);
      instructions.i64Load(0);
      return;
    }
    this.emitClosure(instructions, this.constructorClosureSlot(constructorIndex, 0), []);
  }

  constructorClosureSlot(constructorIndex: number, stage: number): number {
    const slots = this.#constructorClosureSlots[constructorIndex];
    if (slots === undefined || stage >= slots.length) {
      throw new Error(
        `functional WASM constructor ${constructorIndex} omitted application stage ${stage}`,
      );
    }
    const existing = slots[stage];
    if (existing !== undefined) return existing;

    const slot = this.reserveIndirectFunction();
    slots[stage] = slot;
    const instructions = new WasmInstructions(2);
    const fields: ValueSource[] = Array.from(
      { length: stage },
      (_, index) => ({
        kind: "capture",
        byteOffset: OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH,
      }),
    );
    fields.push({ kind: "i64-local", index: 1 });
    if (stage + 1 === slots.length) {
      this.emitConstructor(instructions, constructorIndex, fields);
    } else {
      this.emitClosure(
        instructions,
        this.constructorClosureSlot(constructorIndex, stage + 1),
        fields,
      );
    }
    this.#indirectFunctions[slot] = functionBody(
      2,
      instructions,
      `constructor ${constructorIndex} stage ${stage}`,
    );
    return slot;
  }

  compileLambda(
    instructions: WasmInstructions,
    lambdaNode: number,
    environment: FunctionalEnvironment,
  ): void {
    const lambda = this.node(lambdaNode);
    if (lambda.tag !== FunctionalCoreTag.Lambda) {
      throw new Error(
        `functional WASM lambda compilation received core tag ${lambda.tag} at node ${lambdaNode}`,
      );
    }
    const slot = this.lambdaSlot(lambdaNode);
    const captured = this.prunedCaptures(
      lambda.child0,
      1,
      environment,
      OBJECT_HEADER_BYTE_LENGTH,
    );
    this.emitClosure(instructions, slot, captured.captureSources);
  }

  compileApply(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
    nodeIndex: number,
  ): void {
    const constructorApplication = this.constructorApplication(nodeIndex);
    if (constructorApplication !== undefined) {
      const fields: ValueSource[] = [];
      for (const argumentNode of constructorApplication.argumentNodes) {
        this.compileLazyValue(instructions, argumentNode, environment);
        const field = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(field);
        fields.push({ kind: "i64-local", index: field });
      }
      const arity = this.#module.constructorArities[constructorApplication.constructorIndex]!;
      if (fields.length === arity) {
        this.emitConstructor(instructions, constructorApplication.constructorIndex, fields);
      } else {
        this.emitClosure(
          instructions,
          this.constructorClosureSlot(constructorApplication.constructorIndex, fields.length),
          fields,
        );
      }
      return;
    }

    const virtualCallee = this.virtualLambda(node.child0, environment);
    if (virtualCallee !== undefined) {
      this.compileVirtualLambdaApplication(
        instructions,
        virtualCallee,
        node.child1,
        environment,
      );
      return;
    }

    const callee = this.node(node.child0);
    if (callee.tag === FunctionalCoreTag.Lambda) {
      if (this.immediatelyForcesLocal(callee.child0, 0)) {
        this.compileExpression(instructions, node.child1, environment);
      } else {
        this.compileLazyValue(instructions, node.child1, environment);
      }
      const argument = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(argument);
      this.compileExpression(
        instructions,
        callee.child0,
        [{ kind: "i64-local", index: argument }, ...environment],
      );
      return;
    }

    const lambdaSet = this.#lambdaSetAnalysis.lambdaSet(node.child0);
    if (lambdaSet.complete && lambdaSet.lambdaNodes.length > 0) {
      this.compileExpression(instructions, node.child0, environment);
      instructions.emit(0xa7);
      const closure = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(closure);
      if (this.lambdaSetImmediatelyForcesArgument(lambdaSet.lambdaNodes)) {
        this.compileExpression(instructions, node.child1, environment);
      } else {
        this.compileLazyValue(instructions, node.child1, environment);
      }
      const argument = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(argument);
      this.emitLambdaSetCall(
        instructions,
        closure,
        argument,
        lambdaSet.lambdaNodes,
      );
      return;
    }

    this.compileExpression(instructions, node.child0, environment);
    instructions.emit(0xa7);
    const closure = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(closure);
    instructions.localGet(closure);
    if (this.calleeImmediatelyForcesArgument(node.child0)) {
      this.compileExpression(instructions, node.child1, environment);
    } else {
      this.compileLazyValue(instructions, node.child1, environment);
    }
    instructions.localGet(closure);
    instructions.i32Load(4);
    instructions.emit(0x11);
    instructions.unsigned(2);
    instructions.unsigned(0);
  }

  compileVirtualLambdaApplication(
    instructions: WasmInstructions,
    callee: VirtualLambda,
    argumentNode: number,
    environment: FunctionalEnvironment,
  ): void {
    const lambda = this.node(callee.node);
    if (lambda.tag !== FunctionalCoreTag.Lambda) {
      throw new Error(
        `functional WASM virtual callee ${callee.node} has core tag ${lambda.tag}`,
      );
    }
    const virtualArgument = this.virtualLambda(argumentNode, environment);
    const hasCaptures = this.#captureAnalysis.freeLocalDepths(lambda.child0).some((depth) =>
      depth >= 1
    );
    const canInline = this.#remainingSpecializedInlineSites > 0 &&
      !this.#activeSpecializedLambdas.has(callee.node) &&
      (virtualArgument !== undefined || hasCaptures);

    let argument: FunctionalBinding;
    if (virtualArgument !== undefined) {
      argument = virtualArgument;
    } else {
      if (this.immediatelyForcesLocal(lambda.child0, 0)) {
        this.compileExpression(instructions, argumentNode, environment);
      } else {
        this.compileLazyValue(instructions, argumentNode, environment);
      }
      const argumentLocal = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(argumentLocal);
      argument = { kind: "i64-local", index: argumentLocal };
    }

    if (canInline) {
      this.#remainingSpecializedInlineSites -= 1;
      this.#activeSpecializedLambdas.add(callee.node);
      try {
        this.compileExpression(
          instructions,
          lambda.child0,
          [argument, ...callee.environment],
        );
      } finally {
        this.#activeSpecializedLambdas.delete(callee.node);
      }
      return;
    }

    const argumentLocal = instructions.addLocal(WasmValueType.I64);
    this.emitBinding(instructions, argument);
    instructions.localSet(argumentLocal);
    const closure = instructions.addLocal(WasmValueType.I32);
    if (hasCaptures) {
      this.emitBinding(instructions, callee);
      instructions.emit(0xa7);
    } else {
      instructions.i32Const(0);
    }
    instructions.localSet(closure);
    this.emitDirectLambdaCall(instructions, closure, argumentLocal, callee.node);
  }

  virtualLambda(
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): VirtualLambda | undefined {
    const node = this.node(nodeIndex);
    if (node.tag === FunctionalCoreTag.Lambda) {
      if (this.#recursiveLambdaOwners.has(nodeIndex)) return undefined;
      return { kind: "virtual-lambda", node: nodeIndex, environment };
    }
    if (node.tag === FunctionalCoreTag.Local) {
      const binding = environment[node.payload];
      return binding?.kind === "virtual-lambda" ? binding : undefined;
    }
    if (node.tag !== FunctionalCoreTag.Global || node.payload >= this.#module.definitionCount) {
      return undefined;
    }
    const root = this.#module.definitionRoots[node.payload];
    if (root === undefined || this.node(root).tag !== FunctionalCoreTag.Lambda) return undefined;
    return { kind: "virtual-lambda", node: root, environment: [] };
  }

  compileLet(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
  ): void {
    const virtualValue = this.virtualLambda(node.child0, environment);
    if (virtualValue !== undefined) {
      this.compileExpression(instructions, node.child1, [virtualValue, ...environment]);
      return;
    }
    if (this.expressionIsWhnf(node.child0) || this.immediatelyForcesLocal(node.child1, 0)) {
      this.compileExpression(instructions, node.child0, environment);
    } else {
      this.compileLazyValue(instructions, node.child0, environment);
    }
    const value = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(value);
    this.compileExpression(
      instructions,
      node.child1,
      [{ kind: "i64-local", index: value }, ...environment],
    );
  }

  compileLetRec(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
    nodeIndex: number,
  ): void {
    const lambda = this.node(node.child0);
    if (lambda.tag !== FunctionalCoreTag.Lambda) {
      throw new Error(
        `functional WASM let-rec at core node ${nodeIndex} binds tag ${lambda.tag}; expected a lambda`,
      );
    }
    const slot = this.lambdaSlot(node.child0);
    const capturesSelf = this.#captureAnalysis.freeLocalDepths(lambda.child0).includes(1);
    const firstOuterCaptureByteOffset = OBJECT_HEADER_BYTE_LENGTH +
      (capturesSelf ? VALUE_BYTE_LENGTH : 0);
    const captured = this.prunedCaptures(
      lambda.child0,
      2,
      environment,
      firstOuterCaptureByteOffset,
    );
    const pointer = this.allocateObject(
      instructions,
      CLOSURE_OBJECT_KIND,
      slot,
      captured.captureSources.length + (capturesSelf ? 1 : 0),
    );
    if (capturesSelf) {
      instructions.localGet(pointer);
      instructions.localGet(pointer);
      instructions.emit(0xad);
      instructions.i64Store(OBJECT_HEADER_BYTE_LENGTH);
    }
    for (const [index, source] of captured.captureSources.entries()) {
      instructions.localGet(pointer);
      this.emitBinding(instructions, source);
      instructions.i64Store(firstOuterCaptureByteOffset + index * VALUE_BYTE_LENGTH);
    }
    this.compileExpression(
      instructions,
      node.child1,
      [{ kind: "i32-pointer", index: pointer }, ...environment],
    );
  }

  compileIf(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
  ): void {
    this.compileExpression(instructions, node.child0, environment);
    instructions.i64Const(10n);
    instructions.emit(0x51, 0x04, WasmValueType.I64);
    this.compileExpression(instructions, node.child1, environment);
    instructions.emit(0x05);
    this.compileExpression(instructions, node.child2, environment);
    instructions.emit(0x0b);
  }

  compileUnary(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
    nodeIndex: number,
  ): void {
    if (node.payload !== FunctionalUnaryOperator.Negate) {
      throw new Error(
        `functional WASM unary operator ${node.payload} at core node ${nodeIndex} is unsupported`,
      );
    }
    this.compileExpression(instructions, node.child0, environment);
    this.emitDecodeInteger(instructions);
    instructions.i32Const(-1);
    instructions.emit(0x6c);
    this.emitEncodeInteger(instructions);
  }

  compileBinary(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
    nodeIndex: number,
  ): void {
    this.compileExpression(instructions, node.child0, environment);
    this.emitDecodeInteger(instructions);
    const left = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(left);
    this.compileExpression(instructions, node.child1, environment);
    this.emitDecodeInteger(instructions);
    const right = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(right);
    instructions.localGet(left);
    instructions.localGet(right);
    switch (node.payload) {
      case FunctionalBinaryOperator.Equal:
        instructions.emit(0x46);
        this.emitEncodeBoolean(instructions);
        return;
      case FunctionalBinaryOperator.NotEqual:
        instructions.emit(0x47);
        this.emitEncodeBoolean(instructions);
        return;
      case FunctionalBinaryOperator.Less:
        instructions.emit(0x48);
        this.emitEncodeBoolean(instructions);
        return;
      case FunctionalBinaryOperator.LessEqual:
        instructions.emit(0x4c);
        this.emitEncodeBoolean(instructions);
        return;
      case FunctionalBinaryOperator.Greater:
        instructions.emit(0x4a);
        this.emitEncodeBoolean(instructions);
        return;
      case FunctionalBinaryOperator.GreaterEqual:
        instructions.emit(0x4e);
        this.emitEncodeBoolean(instructions);
        return;
      case FunctionalBinaryOperator.Add:
        instructions.emit(0x6a);
        this.emitEncodeInteger(instructions);
        return;
      case FunctionalBinaryOperator.Subtract:
        instructions.emit(0x6b);
        this.emitEncodeInteger(instructions);
        return;
      case FunctionalBinaryOperator.Multiply:
        instructions.emit(0x6c);
        this.emitEncodeInteger(instructions);
        return;
      case FunctionalBinaryOperator.Divide:
        instructions.emit(0x1a, 0x1a);
        instructions.localGet(left);
        instructions.emit(0xac);
        instructions.localGet(right);
        instructions.emit(0xac, 0x7f, 0xa7);
        this.emitEncodeInteger(instructions);
        return;
      default:
        throw new Error(
          `functional WASM binary operator ${node.payload} at core node ${nodeIndex} is unsupported`,
        );
    }
  }

  compileCase(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
    nodeIndex: number,
  ): void {
    this.compileExpression(instructions, node.child0, environment);
    instructions.emit(0xa7);
    const constructor = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(constructor);
    this.compileCaseArm(instructions, node.child1, constructor, environment, nodeIndex);
  }

  compileCaseArm(
    instructions: WasmInstructions,
    armIndex: number,
    constructor: number,
    environment: FunctionalEnvironment,
    caseNodeIndex: number,
  ): void {
    let currentArmIndex = armIndex;
    let openArmCount = 0;
    while (currentArmIndex !== FUNCTIONAL_NO_INDEX) {
      const arm = this.node(currentArmIndex);
      if (arm.tag !== FunctionalCoreTag.CaseArm) {
        throw new Error(
          `functional WASM case at core node ${caseNodeIndex} links tag ${arm.tag} at node ${currentArmIndex}; expected a case arm`,
        );
      }
      const arity = this.#module.constructorArities[arm.payload];
      if (arity === undefined) {
        throw new Error(
          `functional WASM case arm ${currentArmIndex} refers to missing constructor ${arm.payload}`,
        );
      }
      instructions.localGet(constructor);
      instructions.i32Load(4);
      instructions.i32Const(arm.payload);
      instructions.emit(0x46, 0x04, WasmValueType.I64);
      let bodyNode = arm.child0;
      let armEnvironment = [...environment];
      for (let bindingIndex = 0; bindingIndex < arity; bindingIndex++) {
        const binding = this.node(bodyNode);
        if (binding.tag !== FunctionalCoreTag.PatternBind) {
          throw new Error(
            `functional WASM case arm ${currentArmIndex} has ${bindingIndex} bindings before tag ${binding.tag}; expected ${arity}`,
          );
        }
        instructions.localGet(constructor);
        instructions.i64Load(
          OBJECT_HEADER_BYTE_LENGTH + (arity - bindingIndex - 1) * VALUE_BYTE_LENGTH,
        );
        const field = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(field);
        armEnvironment = [{ kind: "i64-local", index: field }, ...armEnvironment];
        bodyNode = binding.child0;
      }
      this.compileExpression(instructions, bodyNode, armEnvironment);
      instructions.emit(0x05);
      openArmCount += 1;
      currentArmIndex = arm.child1;
    }
    instructions.emit(0x00);
    for (let index = 0; index < openArmCount; index++) instructions.emit(0x0b);
  }

  compileThunk(
    instructions: WasmInstructions,
    expressionNode: number,
    environment: FunctionalEnvironment,
  ): void {
    const slot = this.reserveIndirectFunction();
    const captured = this.prunedCaptures(
      expressionNode,
      0,
      environment,
      THUNK_HEADER_BYTE_LENGTH,
    );
    const bodyInstructions = new WasmInstructions(1);
    this.compileExpression(bodyInstructions, expressionNode, captured.bodyEnvironment);
    this.#indirectFunctions[slot] = functionBody(
      4,
      bodyInstructions,
      `thunk core node ${expressionNode}`,
    );
    this.emitThunkObject(instructions, slot, captured.captureSources);
  }

  compileLazyValue(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): void {
    if (this.expressionIsWhnf(nodeIndex)) {
      this.compileExpression(instructions, nodeIndex, environment);
      return;
    }
    const node = this.node(nodeIndex);
    if (node.tag === FunctionalCoreTag.Local) {
      this.emitBinding(instructions, this.localSource(environment, node.payload, nodeIndex));
      return;
    }
    if (node.tag === FunctionalCoreTag.Global) {
      if (node.payload >= this.#module.definitionCount) {
        throw new Error(
          `functional WASM global d${node.payload} at core node ${nodeIndex} exceeds ${this.#module.definitionCount} definitions`,
        );
      }
      instructions.i32Const(node.payload * VALUE_BYTE_LENGTH);
      instructions.i64Load(0);
      return;
    }
    this.compileThunk(instructions, nodeIndex, environment);
  }

  localSource(
    environment: FunctionalEnvironment,
    depth: number,
    nodeIndex: number,
  ): FunctionalBinding {
    const source = environment[depth];
    if (source !== undefined) return source;
    throw new Error(
      depth < environment.length
        ? `functional WASM local depth ${depth} at core node ${nodeIndex} was pruned from its closure captures`
        : `functional WASM local depth ${depth} at core node ${nodeIndex} exceeds environment depth ${environment.length}`,
    );
  }

  prunedCaptures(
    bodyNode: number,
    binderDepth: number,
    environment: FunctionalEnvironment,
    firstCaptureByteOffset: number,
  ): {
    readonly captureSources: readonly FunctionalBinding[];
    readonly bodyEnvironment: FunctionalEnvironment;
  } {
    const captureSources: FunctionalBinding[] = [];
    const bodyEnvironment: (FunctionalBinding | undefined)[] = Array.from(
      { length: environment.length },
      () => undefined,
    );
    for (const freeDepth of this.#captureAnalysis.freeLocalDepths(bodyNode)) {
      if (freeDepth < binderDepth) continue;
      const environmentDepth = freeDepth - binderDepth;
      if (environmentDepth >= environment.length) {
        throw new Error(
          `functional WASM closure at core node ${bodyNode} references local depth ${freeDepth} beyond binder depth ${binderDepth} and environment depth ${environment.length}`,
        );
      }
      const source = environment[environmentDepth];
      if (source === undefined) {
        throw new Error(
          `functional WASM closure at core node ${bodyNode} references local depth ${freeDepth} that an enclosing closure pruned`,
        );
      }
      bodyEnvironment[environmentDepth] = {
        kind: "capture",
        byteOffset: firstCaptureByteOffset + captureSources.length * VALUE_BYTE_LENGTH,
      };
      captureSources.push(source);
    }
    return { captureSources, bodyEnvironment };
  }

  constructorApplication(nodeIndex: number): ConstructorApplication | undefined {
    const reverseArguments: number[] = [];
    let calleeIndex = nodeIndex;
    let callee = this.node(calleeIndex);
    while (callee.tag === FunctionalCoreTag.Apply) {
      reverseArguments.push(callee.child1);
      calleeIndex = callee.child0;
      callee = this.node(calleeIndex);
    }
    if (callee.tag !== FunctionalCoreTag.Constructor) return undefined;
    const arity = this.#module.constructorArities[callee.payload];
    if (
      arity === undefined || reverseArguments.length === 0 || reverseArguments.length > arity
    ) {
      return undefined;
    }
    return {
      constructorIndex: callee.payload,
      argumentNodes: Object.freeze(reverseArguments.reverse()),
    };
  }

  emitThunkObject(
    instructions: WasmInstructions,
    slot: number,
    captures: readonly FunctionalBinding[],
  ): void {
    instructions.i32Const(THUNK_HEADER_BYTE_LENGTH + captures.length * VALUE_BYTE_LENGTH);
    instructions.call(this.allocateFunctionIndex());
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(pointer);
    instructions.localGet(pointer);
    instructions.i32Const(THUNK_OBJECT_KIND);
    instructions.i32Store(0);
    instructions.localGet(pointer);
    instructions.i32Const(THUNK_UNEVALUATED);
    instructions.i32Store(4);
    instructions.localGet(pointer);
    instructions.i32Const(slot);
    instructions.i32Store(8);
    instructions.localGet(pointer);
    instructions.i32Const(captures.length);
    instructions.i32Store(12);
    for (const [index, source] of captures.entries()) {
      instructions.localGet(pointer);
      this.emitBinding(instructions, source);
      instructions.i64Store(THUNK_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH);
    }
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  emitForceValue(instructions: WasmInstructions): void {
    const value = instructions.addLocal(WasmValueType.I64);
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(value);
    instructions.localGet(value);
    instructions.i64Const(7n);
    instructions.emit(0x83, 0x50, 0x04, WasmValueType.I64);
    instructions.localGet(value);
    instructions.emit(0xa7);
    instructions.localTee(pointer);
    instructions.i32Load(0);
    instructions.i32Const(THUNK_OBJECT_KIND);
    instructions.emit(0x46, 0x04, WasmValueType.I64);
    instructions.localGet(pointer);
    instructions.i32Load(4);
    instructions.i32Const(THUNK_EVALUATED);
    instructions.emit(0x46, 0x04, WasmValueType.I64);
    instructions.localGet(pointer);
    instructions.i64Load(16);
    instructions.emit(0x05);
    instructions.localGet(pointer);
    instructions.call(this.forceThunkFunctionIndex());
    instructions.emit(0x0b, 0x05);
    instructions.localGet(value);
    instructions.emit(0x0b, 0x05);
    instructions.localGet(value);
    instructions.emit(0x0b);
  }

  expressionIsWhnf(nodeIndex: number): boolean {
    switch (this.node(nodeIndex).tag) {
      case FunctionalCoreTag.Integer:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Lambda:
      case FunctionalCoreTag.Constructor:
        return true;
      default:
        return false;
    }
  }

  calleeImmediatelyForcesArgument(nodeIndex: number): boolean {
    const node = this.node(nodeIndex);
    return node.tag === FunctionalCoreTag.Lambda && this.immediatelyForcesLocal(node.child0, 0);
  }

  lambdaSetImmediatelyForcesArgument(lambdaNodes: readonly number[]): boolean {
    return lambdaNodes.every((lambdaNode) => {
      const lambda = this.node(lambdaNode);
      return lambda.tag === FunctionalCoreTag.Lambda &&
        this.immediatelyForcesLocal(lambda.child0, 0);
    });
  }

  immediatelyForcesLocal(nodeIndex: number, localDepth: number): boolean {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Local:
        return node.payload === localDepth;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.Case:
      case FunctionalCoreTag.If:
        return this.immediatelyForcesLocal(node.child0, localDepth);
      case FunctionalCoreTag.Binary:
      case FunctionalCoreTag.Apply:
        return this.immediatelyForcesLocal(node.child0, localDepth);
      case FunctionalCoreTag.Let:
      case FunctionalCoreTag.LetRec:
        return this.immediatelyForcesLocal(node.child1, localDepth + 1);
      default:
        return false;
    }
  }

  emitClosure(
    instructions: WasmInstructions,
    slot: number,
    captures: readonly FunctionalBinding[],
  ): void {
    const pointer = this.allocateObject(
      instructions,
      CLOSURE_OBJECT_KIND,
      slot,
      captures.length,
    );
    for (const [index, source] of captures.entries()) {
      instructions.localGet(pointer);
      this.emitBinding(instructions, source);
      instructions.i64Store(OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH);
    }
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  emitConstructor(
    instructions: WasmInstructions,
    constructorIndex: number,
    fields: readonly FunctionalBinding[],
  ): void {
    const pointer = this.allocateObject(
      instructions,
      CONSTRUCTOR_OBJECT_KIND,
      constructorIndex,
      fields.length,
    );
    for (const [index, source] of fields.entries()) {
      instructions.localGet(pointer);
      this.emitBinding(instructions, source);
      instructions.i64Store(OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH);
    }
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  allocateObject(
    instructions: WasmInstructions,
    kind: number,
    payload: number,
    valueCount: number,
  ): number {
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH + valueCount * VALUE_BYTE_LENGTH);
    instructions.call(this.allocateFunctionIndex());
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localTee(pointer);
    instructions.i32Const(kind);
    instructions.i32Store(0);
    instructions.localGet(pointer);
    instructions.i32Const(payload);
    instructions.i32Store(4);
    instructions.localGet(pointer);
    instructions.i32Const(valueCount);
    instructions.i32Store(8);
    return pointer;
  }

  emitBinding(instructions: WasmInstructions, source: FunctionalBinding): void {
    switch (source.kind) {
      case "i64-local":
        instructions.localGet(source.index);
        return;
      case "i32-pointer":
        instructions.localGet(source.index);
        instructions.emit(0xad);
        return;
      case "capture":
        instructions.localGet(0);
        instructions.i64Load(source.byteOffset);
        return;
      case "virtual-lambda": {
        const lambda = this.node(source.node);
        if (lambda.tag !== FunctionalCoreTag.Lambda) {
          throw new Error(
            `functional WASM virtual lambda ${source.node} has core tag ${lambda.tag}`,
          );
        }
        const captured = this.prunedCaptures(
          lambda.child0,
          1,
          source.environment,
          OBJECT_HEADER_BYTE_LENGTH,
        );
        this.emitClosure(instructions, this.lambdaSlot(source.node), captured.captureSources);
        return;
      }
    }
  }

  emitDecodeInteger(instructions: WasmInstructions): void {
    instructions.i64Const(3n);
    instructions.emit(0x87, 0xa7);
  }

  emitHostArgument(
    instructions: WasmInstructions,
    type: FunctionalHostScalarType,
  ): void {
    if (type.kind === "unit") {
      instructions.emit(0x1a);
      instructions.i32Const(0);
      return;
    }
    this.emitDecodeInteger(instructions);
  }

  emitHostResult(
    instructions: WasmInstructions,
    type: FunctionalHostScalarType,
  ): void {
    if (type.kind === "integer") {
      this.emitEncodeInteger(instructions);
      return;
    }
    if (type.kind === "boolean") {
      this.emitEncodeBoolean(instructions);
      return;
    }
    instructions.emit(0x1a);
    const constructorIndex = this.#module.constructorNames.indexOf(
      FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
    );
    if (constructorIndex < 0) {
      throw new Error(
        `functional WASM host unit result omitted the $Unit constructor among ${this.#module.constructorCount} constructors`,
      );
    }
    const offset = this.#nullaryConstructorOffsets[constructorIndex];
    if (offset === undefined) {
      throw new Error(
        `functional WASM host unit result omitted its shared constructor slot for ${constructorIndex}`,
      );
    }
    instructions.i32Const(offset);
    instructions.i64Load(0);
  }

  emitEncodeInteger(instructions: WasmInstructions): void {
    instructions.emit(0xac);
    instructions.i64Const(3n);
    instructions.emit(0x86);
    instructions.i64Const(1n);
    instructions.emit(0x84);
  }

  emitEncodeBoolean(instructions: WasmInstructions): void {
    instructions.emit(0xad);
    instructions.i64Const(3n);
    instructions.emit(0x86);
    instructions.i64Const(2n);
    instructions.emit(0x84);
  }

  emitLambdaSetCall(
    instructions: WasmInstructions,
    closure: number,
    argument: number,
    lambdaNodes: readonly number[],
  ): void {
    const [lambdaNode, ...remaining] = lambdaNodes;
    if (lambdaNode === undefined) {
      throw new Error("functional WASM lambda-set call omitted every lambda node");
    }
    if (remaining.length === 0) {
      this.emitDirectLambdaCall(instructions, closure, argument, lambdaNode);
      return;
    }

    instructions.localGet(closure);
    instructions.i32Load(4);
    instructions.i32Const(this.lambdaSlot(lambdaNode));
    instructions.emit(0x46, 0x04, WasmValueType.I64);
    this.emitDirectLambdaCall(instructions, closure, argument, lambdaNode);
    instructions.emit(0x05);
    this.emitLambdaSetCall(instructions, closure, argument, remaining);
    instructions.emit(0x0b);
  }

  emitDirectLambdaCall(
    instructions: WasmInstructions,
    closure: number,
    argument: number,
    lambdaNode: number,
  ): void {
    this.#specializedCallSiteCount += 1;
    instructions.localGet(closure);
    instructions.localGet(argument);
    instructions.call(this.indirectFunctionOffset() + this.lambdaSlot(lambdaNode));
  }

  lambdaSlot(lambdaNode: number): number {
    const existing = this.#lambdaSlots[lambdaNode];
    if (existing !== undefined) return existing;
    const lambda = this.node(lambdaNode);
    if (lambda.tag !== FunctionalCoreTag.Lambda) {
      throw new Error(
        `functional WASM lambda-set origin ${lambdaNode} has core tag ${lambda.tag}; expected a lambda`,
      );
    }

    const slot = this.reserveIndirectFunction();
    this.#lambdaSlots[lambdaNode] = slot;
    const recursiveOwner = this.#recursiveLambdaOwners.get(lambdaNode);
    const bodyInstructions = new WasmInstructions(2);
    if (recursiveOwner === undefined) {
      this.compileExpression(
        bodyInstructions,
        lambda.child0,
        [
          { kind: "i64-local", index: 1 },
          ...this.lambdaCaptureEnvironment(lambda.child0, 1, OBJECT_HEADER_BYTE_LENGTH),
        ],
      );
    } else {
      const capturesSelf = this.#captureAnalysis.freeLocalDepths(lambda.child0).includes(1);
      const firstOuterCaptureByteOffset = OBJECT_HEADER_BYTE_LENGTH +
        (capturesSelf ? VALUE_BYTE_LENGTH : 0);
      this.compileExpression(
        bodyInstructions,
        lambda.child0,
        [
          { kind: "i64-local", index: 1 },
          capturesSelf ? { kind: "capture", byteOffset: OBJECT_HEADER_BYTE_LENGTH } : undefined,
          ...this.lambdaCaptureEnvironment(lambda.child0, 2, firstOuterCaptureByteOffset),
        ],
      );
    }
    this.#indirectFunctions[slot] = functionBody(
      2,
      bodyInstructions,
      recursiveOwner === undefined
        ? `lambda core node ${lambdaNode}`
        : `recursive lambda core node ${lambdaNode}`,
    );
    return slot;
  }

  lambdaCaptureEnvironment(
    bodyNode: number,
    binderDepth: number,
    firstCaptureByteOffset: number,
  ): FunctionalEnvironment {
    const freeDepths = this.#captureAnalysis.freeLocalDepths(bodyNode).filter((depth) =>
      depth >= binderDepth
    );
    const lastFreeDepth = freeDepths.at(-1);
    if (lastFreeDepth === undefined) return [];
    const environment: (ValueSource | undefined)[] = Array.from(
      { length: lastFreeDepth - binderDepth + 1 },
      () => undefined,
    );
    for (const [captureIndex, freeDepth] of freeDepths.entries()) {
      environment[freeDepth - binderDepth] = {
        kind: "capture",
        byteOffset: firstCaptureByteOffset + captureIndex * VALUE_BYTE_LENGTH,
      };
    }
    return environment;
  }

  reserveIndirectFunction(): number {
    const slot = this.#indirectFunctions.length;
    this.#indirectFunctions.push(undefined);
    return slot;
  }

  allocateFunctionIndex(): number {
    return this.#functionImports.length;
  }

  forceThunkFunctionIndex(): number {
    return this.#functionImports.length + 1;
  }

  indirectFunctionOffset(): number {
    return this.#functionImports.length + 2;
  }

  node(index: number): FunctionalCoreNode {
    const node = this.#nodes[index];
    if (node === undefined) {
      throw new Error(
        `functional WASM core node ${index} is outside ${this.#nodes.length} resolved nodes`,
      );
    }
    return node;
  }
}

function functionalWasmEntry(module: GpuFunctionalModule): FunctionalWasmEntry {
  const scalarResult = functionalHostScalarType(module.entryType);
  if (scalarResult !== undefined) {
    if (module.hostCapabilities.length !== 0) {
      throw new TypeError(
        `functional WASM entry d${module.entryDefinition} declares ${module.hostCapabilities.length} host capabilities but does not accept ${FUNCTIONAL_INIT_TYPE_NAME}`,
      );
    }
    return { takesInit: false, result: scalarResult };
  }
  if (module.entryType.kind !== "function") {
    throw unsupportedWasmEntryType(module, module.entryType);
  }
  const parameter = module.entryType.parameter;
  const result = functionalHostScalarType(module.entryType.result);
  if (
    parameter.kind !== "named" || parameter.name !== FUNCTIONAL_INIT_TYPE_NAME ||
    parameter.arguments.length !== 0 || result === undefined
  ) {
    throw unsupportedWasmEntryType(module, module.entryType);
  }
  if (module.hostCapabilities.length === 0) {
    throw new TypeError(
      `functional WASM entry d${module.entryDefinition} accepts ${FUNCTIONAL_INIT_TYPE_NAME} but declares no host capabilities`,
    );
  }
  return { takesInit: true, result };
}

function unsupportedWasmEntryType(
  module: GpuFunctionalModule,
  type: FunctionalType,
): TypeError {
  return new TypeError(
    `functional WASM entry d${module.entryDefinition} has unsupported type ${
      describeFunctionalType(type)
    }; ` +
      `expected a scalar result or ${FUNCTIONAL_INIT_TYPE_NAME} -> scalar result`,
  );
}

function functionalHostScalarType(type: FunctionalType): FunctionalHostScalarType | undefined {
  if (type.kind === "integer" || type.kind === "boolean" || type.kind === "unit") return type;
  return undefined;
}

function describeFunctionalType(type: FunctionalType): string {
  switch (type.kind) {
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "unit":
      return "unit";
    case "named":
      return type.arguments.length === 0
        ? type.name
        : `${type.name}(${type.arguments.map(describeFunctionalType).join(", ")})`;
    case "tuple":
      return `(${type.values.map(describeFunctionalType).join(", ")})`;
    case "function":
      return `${describeFunctionalType(type.parameter)} -> ${describeFunctionalType(type.result)}`;
  }
}

function functionalWasmImports(
  capabilities: readonly FunctionalHostCapabilityDeclaration[],
  init: FunctionalWasmInit | undefined,
): Record<string, Record<string, CallableFunction>> {
  if (capabilities.length === 0) return {};
  if (init === undefined || init === null || typeof init !== "object") {
    throw new TypeError(
      `functional WASM module requires init capabilities ${
        JSON.stringify(capabilities.map((capability) => capability.name))
      }; received ${describeHostBinding(init)}`,
    );
  }
  const imports = Object.create(null) as Record<string, Record<string, CallableFunction>>;
  for (const capability of capabilities) {
    const fields = Object.hasOwn(init, capability.name) ? init[capability.name] : undefined;
    if (fields === undefined || fields === null || typeof fields !== "object") {
      throw new TypeError(
        `functional WASM init omitted capability ${JSON.stringify(capability.name)}; received ${
          describeHostBinding(fields)
        }`,
      );
    }
    const capabilityImports = Object.create(null) as Record<string, CallableFunction>;
    imports[hostImportModule(capability.name)] = capabilityImports;
    for (const declaration of capability.fields) {
      const binding = Object.hasOwn(fields, declaration.name)
        ? fields[declaration.name]
        : undefined;
      const key = hostFieldKey(capability.name, declaration.name);
      if (declaration.kind === "value") {
        if (typeof binding === "function" || binding === undefined) {
          throw new TypeError(
            `functional WASM init value ${
              JSON.stringify(key)
            } expected ${declaration.type.kind}; received ${describeHostBinding(binding)}`,
          );
        }
        const value = hostValueAsNumber(binding, declaration.type, key);
        capabilityImports[declaration.name] = () => value;
        continue;
      }
      if (typeof binding !== "function") {
        throw new TypeError(
          `functional WASM init operation ${JSON.stringify(key)} expected a function; received ${
            describeHostBinding(binding)
          }`,
        );
      }
      capabilityImports[declaration.name] = (argument: number) => {
        const hostArgument = hostValueFromNumber(argument, declaration.parameter);
        const result = binding(hostArgument);
        return hostValueAsNumber(result, declaration.result, key);
      };
    }
  }
  return imports;
}

function hostValueFromNumber(
  value: number,
  type: FunctionalHostScalarType,
): FunctionalWasmHostValue {
  if (type.kind === "integer") return { kind: "integer", value: value | 0 };
  if (type.kind === "boolean") return { kind: "boolean", value: value !== 0 };
  return { kind: "unit" };
}

function hostValueAsNumber(
  value: FunctionalWasmInitBinding,
  expectedType: FunctionalHostScalarType,
  field: string,
): number {
  if (value === null || typeof value !== "object" || typeof value === "function") {
    throw new TypeError(
      `functional WASM host field ${
        JSON.stringify(field)
      } expected ${expectedType.kind}; received ${describeHostBinding(value)}`,
    );
  }
  if (value.kind !== expectedType.kind) {
    throw new TypeError(
      `functional WASM host field ${
        JSON.stringify(field)
      } expected ${expectedType.kind}; received ${describeHostBinding(value)}`,
    );
  }
  if (value.kind === "unit") return 0;
  if (value.kind === "boolean") return value.value ? 1 : 0;
  if (
    !Number.isSafeInteger(value.value) || value.value < -2_147_483_648 ||
    value.value > 2_147_483_647
  ) {
    throw new RangeError(
      `functional WASM host field ${
        JSON.stringify(field)
      } returned integer ${value.value}; expected signed i32`,
    );
  }
  return value.value | 0;
}

function describeHostBinding(binding: unknown): string {
  if (binding === undefined) return "undefined";
  if (binding === null) return "null";
  if (typeof binding === "function") return "function";
  if (typeof binding !== "object") return `${typeof binding} ${JSON.stringify(binding)}`;
  const kind = (binding as { kind?: unknown }).kind;
  return kind === undefined ? "object without a kind" : `object with kind ${JSON.stringify(kind)}`;
}

function hostFieldKey(capability: string, field: string): string {
  return `${capability}.${field}`;
}

function hostImportModule(capability: string): string {
  return `${HOST_IMPORT_MODULE_PREFIX}${capability}`;
}

function allocateFunction(): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const previousTop = instructions.addLocal(WasmValueType.I32);
  const nextTop = instructions.addLocal(WasmValueType.I32);
  instructions.emit(0x23, 0x00);
  instructions.localTee(previousTop);
  instructions.localGet(0);
  instructions.emit(0x6a);
  instructions.localTee(nextTop);
  instructions.emit(0x24, 0x00);
  instructions.localGet(nextTop);
  instructions.i32Const(65_535);
  instructions.emit(0x6a);
  instructions.i32Const(16);
  instructions.emit(0x76, 0x3f, 0x00, 0x4b, 0x04, 0x40);
  instructions.localGet(nextTop);
  instructions.i32Const(65_535);
  instructions.emit(0x6a);
  instructions.i32Const(16);
  instructions.emit(0x76, 0x3f, 0x00, 0x6b, 0x40, 0x00);
  instructions.i32Const(-1);
  instructions.emit(0x46, 0x04, 0x40, 0x00, 0x0b, 0x0b);
  instructions.localGet(previousTop);
  return functionBody(0, instructions, "allocator");
}

function forceThunkFunction(): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const value = instructions.addLocal(WasmValueType.I64);
  instructions.localGet(0);
  instructions.i32Load(4);
  instructions.i32Const(THUNK_EVALUATED);
  instructions.emit(0x46, 0x04, WasmValueType.I64);
  instructions.localGet(0);
  instructions.i64Load(16);
  instructions.emit(0x05);
  instructions.localGet(0);
  instructions.i32Load(4);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.emit(0x05);
  instructions.i32Const(1);
  instructions.emit(0x24, 0x02, 0x00, 0x0b);
  instructions.localGet(0);
  instructions.i32Const(THUNK_EVALUATING);
  instructions.i32Store(4);
  instructions.emit(0x23, 0x01);
  instructions.i32Const(1);
  instructions.emit(0x6a, 0x24, 0x01);
  instructions.localGet(0);
  instructions.localGet(0);
  instructions.i32Load(8);
  instructions.emit(0x11);
  instructions.unsigned(4);
  instructions.unsigned(0);
  instructions.localSet(value);
  instructions.localGet(0);
  instructions.localGet(value);
  instructions.i64Store(16);
  instructions.localGet(0);
  instructions.i32Const(THUNK_EVALUATED);
  instructions.i32Store(4);
  instructions.localGet(value);
  instructions.emit(0x0b);
  return functionBody(4, instructions, "thunk force slow path");
}

function functionBody(
  typeIndex: number,
  instructions: WasmInstructions,
  context: string,
): WasmFunctionBody {
  if (instructions.bytes.length === 0) {
    throw new Error(`functional WASM ${context} emitted no instructions`);
  }
  return {
    typeIndex,
    localTypes: instructions.localTypes,
    instructions: instructions.bytes,
  };
}
