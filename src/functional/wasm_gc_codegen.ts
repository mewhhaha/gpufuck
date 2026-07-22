import {
  FUNCTIONAL_NO_INDEX,
  FunctionalBinaryOperator,
  FunctionalCoreTag,
  FunctionalEvaluationMode,
  FunctionalUnaryOperator,
} from "./abi.ts";
import type { FunctionalCoreNode, GpuFunctionalModule } from "./compiler_module.ts";
import {
  float32FromBits,
  float64FromBits,
  isComparisonOperator,
  numericBinaryOpcode,
  numericConversion,
  numericOperatorGroup,
  type NumericPrimitiveKind,
  wideLiteralBits,
} from "./wasm_numeric.ts";
import { functionalWasmEntry } from "./wasm_host_boundary.ts";
import { FUNCTIONAL_WASM_GC_ABI_VERSION, FunctionalWasmGcValueKind } from "./wasm_gc_contract.ts";
import { FUNCTIONAL_MAXIMUM_STORE_LENGTH } from "./store_contract.ts";
import { WASM_FAULT_OUT_OF_BOUNDS } from "./wasm_runtime_binary.ts";

const VALUE_TYPE_INDEX = 0;
const VALUE_FIELDS_TYPE_INDEX = 1;
const MAIN_TYPE_INDEX = 2;
const CALL_TYPE_INDEX = 3;
const INITIALIZE_TYPE_INDEX = 4;
const FORCE_TYPE_INDEX = 5;
const VALUE_TO_I32_TYPE_INDEX = 6;
const VALUE_TO_I64_TYPE_INDEX = 7;
const VALUE_TO_F32_TYPE_INDEX = 8;
const VALUE_TO_F64_TYPE_INDEX = 9;
const VALUE_FIELD_TYPE_INDEX = 10;
const VALUE_PAYLOAD_FIELD = 1;
const VALUE_STATE_FIELD = 2;
const VALUE_I64_FIELD = 3;
const VALUE_F32_FIELD = 4;
const VALUE_F64_FIELD = 5;
const VALUE_FIELDS_FIELD = 6;

interface GcFunctionBody {
  readonly typeIndex: number;
  readonly localTypes: readonly ("value" | "fields" | "i32")[];
  readonly instructions: readonly number[];
}

interface FunctionalStoreUpdate {
  readonly node: FunctionalCoreNode;
  readonly nodeIndex: number;
}

export function compileFunctionalWasmGc(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
): Uint8Array<ArrayBuffer> {
  if (module.entryEffects.length !== 0) {
    throw new Error(
      `functional WasmGC backend requires a pure entry; received effects ${
        module.entryEffects.map((effect) => JSON.stringify(effect)).join(", ")
      }`,
    );
  }
  if (nodes.length !== module.nodeCount) {
    throw new Error(
      `functional WasmGC backend received ${nodes.length} resolved Core nodes; module declares ${module.nodeCount}`,
    );
  }
  const externalHostFields = module.hostCapabilities.flatMap((capability) => capability.fields);
  if (externalHostFields.length !== 0 || module.hostDefinitions.length !== 0) {
    throw new TypeError(
      `functional WasmGC backend requires a closed module without host fields; received ${externalHostFields.length} declarations and ${module.hostDefinitions.length} definitions`,
    );
  }
  if (module.entryType.kind === "function") {
    throw new TypeError(
      `functional WasmGC backend requires a nullary first-order entry; definition ${module.entryDefinition} has a function type`,
    );
  }
  functionalWasmEntry(module);
  if (module.wasmExports.length !== 0) {
    throw new TypeError(
      `functional WasmGC backend does not yet emit additional callable exports; received ${module.wasmExports.length} declarations`,
    );
  }
  const entryRoot = module.definitionRoots[module.entryDefinition];
  if (entryRoot === undefined || entryRoot >= nodes.length) {
    throw new Error(
      `functional WasmGC backend entry definition ${module.entryDefinition} references root ${
        String(entryRoot)
      } outside ${nodes.length} nodes`,
    );
  }

  const emitter = new GcCoreEmitter(module, nodes);
  return emitter.emitModule(entryRoot);
}

class GcCoreEmitter {
  readonly #module: GpuFunctionalModule;
  readonly #nodes: readonly FunctionalCoreNode[];
  #instructions = new GcInstructions();
  readonly #activeNodes = new Set<number>();
  readonly #lambdaWorkers = new Map<
    number,
    { readonly slot: number; readonly captureCount: number }
  >();
  readonly #constructorWorkers = new Map<string, number>();
  readonly #thunkWorkers = new Map<
    number,
    { readonly slot: number; readonly captureCount: number }
  >();
  readonly #workers: (GcFunctionBody | undefined)[] = [];

  constructor(module: GpuFunctionalModule, nodes: readonly FunctionalCoreNode[]) {
    this.#module = module;
    this.#nodes = nodes;
  }

  emitModule(entryRoot: number): Uint8Array<ArrayBuffer> {
    this.emitExpression(entryRoot, []);
    const main: GcFunctionBody = {
      typeIndex: MAIN_TYPE_INDEX,
      localTypes: this.#instructions.localTypes,
      instructions: this.#instructions.bytes,
    };
    const initialize = this.emitInitializeFunction();
    const force = this.emitForceFunction();
    const workers = this.#workers.map((worker, slot) => {
      if (worker === undefined) {
        throw new Error(`functional WasmGC backend omitted worker ${slot}`);
      }
      return worker;
    });
    return encodeGcModule(
      this.#module.definitionCount,
      main,
      initialize,
      force,
      workers,
    );
  }

  emitExpression(nodeIndex: number, environment: readonly number[]): void {
    if (this.#activeNodes.has(nodeIndex)) {
      throw new Error(
        `functional WasmGC backend found a resolved Core cycle at node ${nodeIndex}`,
      );
    }
    this.#activeNodes.add(nodeIndex);
    try {
      this.emitAcyclicExpression(nodeIndex, environment);
    } finally {
      this.#activeNodes.delete(nodeIndex);
    }
  }

  emitAcyclicExpression(nodeIndex: number, environment: readonly number[]): void {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
        this.emitLiteralValue(FunctionalWasmGcValueKind.Integer, node.payload | 0);
        return;
      case FunctionalCoreTag.Boolean:
        this.emitLiteralValue(FunctionalWasmGcValueKind.Boolean, node.payload);
        return;
      case FunctionalCoreTag.SignedInteger64:
        this.emitNumericValue("signed-integer-64", () => {
          this.#instructions.i64Const(wideLiteralBits(node));
        });
        return;
      case FunctionalCoreTag.Float32:
        this.emitNumericValue("float-32", () => {
          this.#instructions.f32Const(float32FromBits(node.payload));
        });
        return;
      case FunctionalCoreTag.Float64:
        this.emitNumericValue("float-64", () => {
          this.#instructions.f64Const(float64FromBits(wideLiteralBits(node)));
        });
        return;
      case FunctionalCoreTag.WholeNumberF64:
        this.emitNumericValue("whole-number-f64", () => {
          this.#instructions.f64Const(float64FromBits(wideLiteralBits(node)));
        });
        return;
      case FunctionalCoreTag.Local: {
        const localIndex = environment[node.payload];
        if (localIndex === undefined) {
          throw new Error(
            `functional WasmGC backend local ${node.payload} at core node ${nodeIndex} exceeds environment depth ${environment.length}`,
          );
        }
        this.#instructions.localGet(localIndex);
        this.#instructions.refAsNonNull();
        this.#instructions.call(2);
        return;
      }
      case FunctionalCoreTag.Global:
        if (node.payload >= this.#module.definitionCount) {
          throw new Error(
            `functional WasmGC backend global ${node.payload} at core node ${nodeIndex} exceeds ${this.#module.definitionCount} definitions`,
          );
        }
        this.#instructions.globalGet(node.payload);
        this.#instructions.refAsNonNull();
        this.#instructions.call(2);
        return;
      case FunctionalCoreTag.Constructor: {
        const arity = this.constructorArity(node.payload, nodeIndex);
        if (arity === 0) {
          this.emitLiteralValue(FunctionalWasmGcValueKind.Constructor, node.payload);
        } else {
          this.emitClosure(this.constructorWorker(node.payload, 0), []);
        }
        return;
      }
      case FunctionalCoreTag.Apply:
        if (this.constructorApplication(nodeIndex) !== undefined) {
          this.emitConstructorApplication(nodeIndex, environment);
        } else {
          this.emitApplication(node, environment);
        }
        return;
      case FunctionalCoreTag.Lambda:
        this.emitClosure(
          this.lambdaWorker(nodeIndex, environment.length),
          environment,
        );
        return;
      case FunctionalCoreTag.Let: {
        if (node.evaluationMode === FunctionalEvaluationMode.StrictEager) {
          this.emitExpression(node.child0, environment);
        } else {
          this.emitThunk(node.child0, environment);
        }
        const valueLocal = this.#instructions.addValueLocal();
        this.#instructions.localSet(valueLocal);
        this.emitExpression(node.child1, [valueLocal, ...environment]);
        return;
      }
      case FunctionalCoreTag.LetRec:
        this.emitLetRec(nodeIndex, node, environment);
        return;
      case FunctionalCoreTag.If:
        this.emitPayload(node.child0, environment);
        this.#instructions.ifValue();
        this.emitExpression(node.child1, environment);
        this.#instructions.else();
        this.emitExpression(node.child2, environment);
        this.#instructions.end();
        return;
      case FunctionalCoreTag.Binary:
        this.emitBinary(nodeIndex, node, environment);
        return;
      case FunctionalCoreTag.Unary:
        this.emitUnary(nodeIndex, node, environment);
        return;
      case FunctionalCoreTag.NumericConvert:
        this.emitNumericConversion(nodeIndex, node, environment);
        return;
      case FunctionalCoreTag.StoreNew:
        this.emitStoreNew(nodeIndex, node, environment);
        return;
      case FunctionalCoreTag.StoreLength:
        this.emitStoreLength(node, environment);
        return;
      case FunctionalCoreTag.StoreRead:
        this.emitStoreRead(nodeIndex, node, environment);
        return;
      case FunctionalCoreTag.StoreWrite:
      case FunctionalCoreTag.StoreGrow:
        this.emitStoreUpdates(nodeIndex, environment);
        return;
      case FunctionalCoreTag.Case:
        this.emitCase(nodeIndex, node, environment);
        return;
      case FunctionalCoreTag.CaseArm:
      case FunctionalCoreTag.PatternBind:
        throw new Error(
          `functional WasmGC backend found structural core tag ${node.tag} in expression position at node ${nodeIndex}`,
        );
      default:
        throw new Error(
          `functional WasmGC backend does not support core tag ${node.tag} at node ${nodeIndex}`,
        );
    }
  }

  emitConstructorApplication(nodeIndex: number, environment: readonly number[]): void {
    const reverseArguments: {
      readonly node: number;
      readonly evaluationMode: FunctionalCoreNode["evaluationMode"];
    }[] = [];
    let calleeIndex = nodeIndex;
    let callee = this.node(calleeIndex);
    while (callee.tag === FunctionalCoreTag.Apply) {
      reverseArguments.push({
        node: callee.child1,
        evaluationMode: callee.evaluationMode,
      });
      calleeIndex = callee.child0;
      callee = this.node(calleeIndex);
    }
    if (callee.tag !== FunctionalCoreTag.Constructor) {
      throw new Error(
        `functional WasmGC backend only supports constructor application; core node ${nodeIndex} resolves to tag ${callee.tag} at node ${calleeIndex}`,
      );
    }
    const arity = this.constructorArity(callee.payload, calleeIndex);
    if (reverseArguments.length > arity) {
      throw new Error(
        `functional WasmGC backend constructor ${callee.payload} at core node ${calleeIndex} received ${reverseArguments.length} arguments; maximum ${arity}`,
      );
    }

    const argumentsInSourceOrder = reverseArguments.reverse();
    const argumentLocals: number[] = [];
    for (const argument of argumentsInSourceOrder) {
      if (argument.evaluationMode === FunctionalEvaluationMode.StrictEager) {
        this.emitExpression(argument.node, environment);
      } else {
        this.emitThunk(argument.node, environment);
      }
      const argumentLocal = this.#instructions.addValueLocal();
      this.#instructions.localSet(argumentLocal);
      argumentLocals.push(argumentLocal);
    }
    if (argumentLocals.length < arity) {
      this.emitClosure(
        this.constructorWorker(callee.payload, argumentLocals.length),
        argumentLocals,
      );
      return;
    }

    this.#instructions.i32Const(FunctionalWasmGcValueKind.Constructor);
    this.#instructions.i32Const(callee.payload);
    this.emitEmptyNumericFields();
    for (const argumentLocal of argumentLocals) {
      this.#instructions.localGet(argumentLocal);
      this.#instructions.refAsNonNull();
    }
    this.#instructions.arrayNewFixed(arity);
    this.#instructions.structNew();
  }

  constructorApplication(nodeIndex: number): boolean | undefined {
    let callee = this.node(nodeIndex);
    while (callee.tag === FunctionalCoreTag.Apply) callee = this.node(callee.child0);
    return callee.tag === FunctionalCoreTag.Constructor ? true : undefined;
  }

  emitApplication(
    node: FunctionalCoreNode,
    environment: readonly number[],
  ): void {
    this.emitExpression(node.child0, environment);
    const calleeLocal = this.#instructions.addValueLocal();
    this.#instructions.localSet(calleeLocal);
    if (node.evaluationMode === FunctionalEvaluationMode.StrictEager) {
      this.emitExpression(node.child1, environment);
    } else {
      this.emitThunk(node.child1, environment);
    }
    const argumentLocal = this.#instructions.addValueLocal();
    this.#instructions.localSet(argumentLocal);

    this.#instructions.localGet(calleeLocal);
    this.#instructions.refAsNonNull();
    this.#instructions.localGet(argumentLocal);
    this.#instructions.refAsNonNull();
    this.#instructions.localGet(calleeLocal);
    this.#instructions.refAsNonNull();
    this.#instructions.structGet(VALUE_PAYLOAD_FIELD);
    this.#instructions.callIndirect();
  }

  emitClosure(slot: number, captureLocals: readonly number[]): void {
    this.#instructions.i32Const(FunctionalWasmGcValueKind.Closure);
    this.#instructions.i32Const(slot);
    this.emitEmptyNumericFields();
    for (const captureLocal of captureLocals) {
      this.#instructions.localGet(captureLocal);
      this.#instructions.refAsNonNull();
    }
    this.#instructions.arrayNewFixed(captureLocals.length);
    this.#instructions.structNew();
  }

  emitThunk(expressionNode: number, captureLocals: readonly number[]): void {
    this.#instructions.i32Const(FunctionalWasmGcValueKind.Thunk);
    this.#instructions.i32Const(this.thunkWorker(expressionNode, captureLocals.length));
    this.emitEmptyNumericFields();
    this.#instructions.refNullValue();
    for (const captureLocal of captureLocals) {
      this.#instructions.localGet(captureLocal);
      this.#instructions.refAsNonNull();
    }
    this.#instructions.arrayNewFixed(captureLocals.length + 1);
    this.#instructions.structNew();
  }

  thunkWorker(expressionNode: number, captureCount: number): number {
    const existing = this.#thunkWorkers.get(expressionNode);
    if (existing !== undefined) {
      if (existing.captureCount !== captureCount) {
        throw new Error(
          `functional WasmGC backend thunk ${expressionNode} has capture depths ${existing.captureCount} and ${captureCount}`,
        );
      }
      return existing.slot;
    }
    const slot = this.reserveWorker();
    this.#thunkWorkers.set(expressionNode, { slot, captureCount });
    this.compileWorker(slot, captureCount, (captures) => {
      this.emitExpression(expressionNode, captures);
    }, 1);
    return slot;
  }

  emitLetRec(
    nodeIndex: number,
    node: FunctionalCoreNode,
    environment: readonly number[],
  ): void {
    const value = this.node(node.child0);
    if (value.tag !== FunctionalCoreTag.Lambda) {
      throw new Error(
        `functional WasmGC backend let-rec at core node ${nodeIndex} binds tag ${value.tag}; expected a lambda`,
      );
    }
    const slot = this.lambdaWorker(node.child0, environment.length + 1);
    this.#instructions.i32Const(FunctionalWasmGcValueKind.Closure);
    this.#instructions.i32Const(slot);
    this.emitEmptyNumericFields();
    this.#instructions.refNullValue();
    for (const captureLocal of environment) {
      this.#instructions.localGet(captureLocal);
      this.#instructions.refAsNonNull();
    }
    this.#instructions.arrayNewFixed(environment.length + 1);
    this.#instructions.structNew();
    const recursiveLocal = this.#instructions.addValueLocal();
    this.#instructions.localSet(recursiveLocal);
    this.#instructions.localGet(recursiveLocal);
    this.#instructions.refAsNonNull();
    this.#instructions.structGet(VALUE_FIELDS_FIELD);
    this.#instructions.i32Const(0);
    this.#instructions.localGet(recursiveLocal);
    this.#instructions.arraySet();
    this.emitExpression(node.child1, [recursiveLocal, ...environment]);
  }

  lambdaWorker(lambdaNode: number, captureCount: number): number {
    const existing = this.#lambdaWorkers.get(lambdaNode);
    if (existing !== undefined) {
      if (existing.captureCount !== captureCount) {
        throw new Error(
          `functional WasmGC backend lambda ${lambdaNode} has capture depths ${existing.captureCount} and ${captureCount}`,
        );
      }
      return existing.slot;
    }
    const lambda = this.node(lambdaNode);
    if (lambda.tag !== FunctionalCoreTag.Lambda) {
      throw new Error(
        `functional WasmGC backend lambda worker ${lambdaNode} has core tag ${lambda.tag}`,
      );
    }
    const slot = this.reserveWorker();
    this.#lambdaWorkers.set(lambdaNode, { slot, captureCount });
    this.compileWorker(slot, captureCount, (captures) => {
      this.emitExpression(lambda.child0, [1, ...captures]);
    });
    return slot;
  }

  constructorWorker(constructorIndex: number, capturedCount: number): number {
    const key = `${constructorIndex}:${capturedCount}`;
    const existing = this.#constructorWorkers.get(key);
    if (existing !== undefined) return existing;
    const arity = this.constructorArity(constructorIndex, constructorIndex);
    if (capturedCount >= arity) {
      throw new Error(
        `functional WasmGC backend constructor ${constructorIndex} worker captures ${capturedCount} fields; arity is ${arity}`,
      );
    }
    const slot = this.reserveWorker();
    this.#constructorWorkers.set(key, slot);
    this.compileWorker(slot, capturedCount, (captures) => {
      const fields = [...captures, 1];
      if (fields.length < arity) {
        this.emitClosure(
          this.constructorWorker(constructorIndex, fields.length),
          fields,
        );
        return;
      }
      this.#instructions.i32Const(FunctionalWasmGcValueKind.Constructor);
      this.#instructions.i32Const(constructorIndex);
      this.emitEmptyNumericFields();
      for (const field of fields) {
        this.#instructions.localGet(field);
        this.#instructions.refAsNonNull();
      }
      this.#instructions.arrayNewFixed(fields.length);
      this.#instructions.structNew();
    });
    return slot;
  }

  reserveWorker(): number {
    const slot = this.#workers.length;
    this.#workers.push(undefined);
    return slot;
  }

  compileWorker(
    slot: number,
    captureCount: number,
    emitBody: (captures: readonly number[]) => void,
    firstCaptureField = 0,
  ): void {
    const outerInstructions = this.#instructions;
    const workerInstructions = new GcInstructions(2);
    this.#instructions = workerInstructions;
    try {
      const captures: number[] = [];
      for (let captureIndex = 0; captureIndex < captureCount; captureIndex += 1) {
        workerInstructions.localGet(0);
        workerInstructions.structGet(VALUE_FIELDS_FIELD);
        workerInstructions.i32Const(firstCaptureField + captureIndex);
        workerInstructions.arrayGet();
        const captureLocal = workerInstructions.addValueLocal();
        workerInstructions.localSet(captureLocal);
        captures.push(captureLocal);
      }
      emitBody(captures);
      this.#workers[slot] = {
        typeIndex: CALL_TYPE_INDEX,
        localTypes: workerInstructions.localTypes,
        instructions: workerInstructions.bytes,
      };
    } finally {
      this.#instructions = outerInstructions;
    }
  }

  emitInitializeFunction(): GcFunctionBody {
    const mainInstructions = this.#instructions;
    const initializeInstructions = new GcInstructions();
    this.#instructions = initializeInstructions;
    try {
      for (const [definitionIndex, rootNode] of this.#module.definitionRoots.entries()) {
        this.emitThunk(rootNode, []);
        initializeInstructions.globalSet(definitionIndex);
      }
      return {
        typeIndex: INITIALIZE_TYPE_INDEX,
        localTypes: initializeInstructions.localTypes,
        instructions: initializeInstructions.bytes,
      };
    } finally {
      this.#instructions = mainInstructions;
    }
  }

  emitForceFunction(): GcFunctionBody {
    const instructions = new GcInstructions(1);
    instructions.localGet(0);
    instructions.structGet(0);
    instructions.i32Const(FunctionalWasmGcValueKind.Thunk);
    instructions.emit(0x46);
    instructions.ifValue();

    instructions.localGet(0);
    instructions.structGet(VALUE_STATE_FIELD);
    instructions.i32Const(2);
    instructions.emit(0x46);
    instructions.ifValue();
    instructions.localGet(0);
    instructions.structGet(VALUE_FIELDS_FIELD);
    instructions.i32Const(0);
    instructions.arrayGet();
    instructions.refAsNonNull();
    instructions.else();

    instructions.localGet(0);
    instructions.structGet(VALUE_STATE_FIELD);
    instructions.i32Const(1);
    instructions.emit(0x46);
    instructions.ifVoid();
    instructions.i32Const(1);
    instructions.globalSet(this.#module.definitionCount + 1);
    instructions.i32Const(-1);
    instructions.globalSet(this.#module.definitionCount + 2);
    instructions.unreachable();
    instructions.end();

    instructions.localGet(0);
    instructions.i32Const(1);
    instructions.structSet(VALUE_STATE_FIELD);
    instructions.localGet(0);
    instructions.localGet(0);
    instructions.localGet(0);
    instructions.structGet(VALUE_PAYLOAD_FIELD);
    instructions.callIndirect();
    const resultLocal = instructions.addValueLocal();
    instructions.localSet(resultLocal);

    instructions.localGet(0);
    instructions.structGet(VALUE_FIELDS_FIELD);
    instructions.i32Const(0);
    instructions.localGet(resultLocal);
    instructions.arraySet();
    instructions.localGet(0);
    instructions.i32Const(2);
    instructions.structSet(VALUE_STATE_FIELD);
    instructions.globalGet(this.#module.definitionCount);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.globalSet(this.#module.definitionCount);
    instructions.localGet(resultLocal);
    instructions.refAsNonNull();
    instructions.end();

    instructions.else();
    instructions.localGet(0);
    instructions.end();
    return {
      typeIndex: FORCE_TYPE_INDEX,
      localTypes: instructions.localTypes,
      instructions: instructions.bytes,
    };
  }

  emitBinary(
    nodeIndex: number,
    node: FunctionalCoreNode,
    environment: readonly number[],
  ): void {
    if (
      node.payload === FunctionalBinaryOperator.StructuralEqual ||
      node.payload === FunctionalBinaryOperator.StructuralNotEqual
    ) {
      throw new Error(
        `functional WasmGC backend does not support structural equality at core node ${nodeIndex}`,
      );
    }
    const opcode = numericBinaryOpcode(node.payload);
    const group = numericOperatorGroup(node.payload);
    if (
      opcode === undefined ||
      node.payload === FunctionalBinaryOperator.Divide ||
      node.payload === FunctionalBinaryOperator.DivideSignedInteger64 ||
      node.payload === FunctionalBinaryOperator.RemainderSignedInteger64
    ) {
      throw new Error(
        `functional WasmGC backend does not support binary operator ${node.payload} at core node ${nodeIndex}`,
      );
    }
    const comparison = isComparisonOperator(node.payload);
    this.emitNumericValue(comparison ? "integer" : group, () => {
      this.emitNumericField(node.child0, environment, group);
      this.emitNumericField(node.child1, environment, group);
      this.#instructions.emit(opcode);
    }, comparison ? FunctionalWasmGcValueKind.Boolean : undefined);
  }

  emitUnary(
    nodeIndex: number,
    node: FunctionalCoreNode,
    environment: readonly number[],
  ): void {
    if (node.payload === FunctionalUnaryOperator.Negate) {
      this.emitNumericValue("integer", () => {
        this.#instructions.i32Const(0);
        this.emitNumericField(node.child0, environment, "integer");
        this.#instructions.emit(0x6b);
      });
      return;
    }
    const wideUnary = node.payload === FunctionalUnaryOperator.NegateSignedInteger64
      ? { group: "signed-integer-64" as const, opcode: 0x7d, zero: "integer" as const }
      : node.payload === FunctionalUnaryOperator.NegateFloat32
      ? { group: "float-32" as const, opcode: 0x8c }
      : node.payload === FunctionalUnaryOperator.SquareRootFloat32
      ? { group: "float-32" as const, opcode: 0x91 }
      : node.payload === FunctionalUnaryOperator.NegateFloat64
      ? { group: "float-64" as const, opcode: 0x9a }
      : node.payload === FunctionalUnaryOperator.NegateWholeNumberF64
      ? { group: "whole-number-f64" as const, opcode: 0x9a }
      : undefined;
    if (wideUnary === undefined) {
      throw new Error(
        `functional WasmGC backend does not support unary operator ${node.payload} at core node ${nodeIndex}`,
      );
    }
    this.emitNumericValue(wideUnary.group, () => {
      if (wideUnary.zero === "integer") this.#instructions.i64Const(0n);
      this.emitNumericField(node.child0, environment, wideUnary.group);
      this.#instructions.emit(wideUnary.opcode);
    });
  }

  emitNumericConversion(
    nodeIndex: number,
    node: FunctionalCoreNode,
    environment: readonly number[],
  ): void {
    const conversion = numericConversion(node.payload);
    if (
      (conversion.source === "float-32" || conversion.source === "float-64") &&
      (conversion.result === "integer" || conversion.result === "signed-integer-64")
    ) {
      throw new Error(
        `functional WasmGC backend does not support trapping numeric conversion ${node.payload} at core node ${nodeIndex}`,
      );
    }
    this.emitNumericValue(conversion.result, () => {
      this.emitNumericField(node.child0, environment, conversion.source);
      this.#instructions.emit(conversion.opcode);
    });
  }

  emitCase(
    caseNodeIndex: number,
    node: FunctionalCoreNode,
    environment: readonly number[],
  ): void {
    this.emitExpression(node.child0, environment);
    const scrutineeLocal = this.#instructions.addValueLocal();
    this.#instructions.localSet(scrutineeLocal);

    const visitedArms = new Set<number>();
    let armIndex = node.child1;
    let openArmCount = 0;
    while (armIndex !== FUNCTIONAL_NO_INDEX) {
      if (visitedArms.has(armIndex)) {
        throw new Error(
          `functional WasmGC backend case at core node ${caseNodeIndex} has a cycle through arm ${armIndex}`,
        );
      }
      visitedArms.add(armIndex);
      const arm = this.node(armIndex);
      if (arm.tag !== FunctionalCoreTag.CaseArm) {
        throw new Error(
          `functional WasmGC backend case at core node ${caseNodeIndex} links tag ${arm.tag} at node ${armIndex}; expected a case arm`,
        );
      }
      const arity = this.constructorArity(arm.payload, armIndex);

      this.#instructions.localGet(scrutineeLocal);
      this.#instructions.refAsNonNull();
      this.#instructions.structGet(VALUE_PAYLOAD_FIELD);
      this.#instructions.i32Const(arm.payload);
      this.#instructions.emit(0x46);
      this.#instructions.ifValue();

      let bodyNode = arm.child0;
      let armEnvironment = [...environment];
      for (let bindingIndex = 0; bindingIndex < arity; bindingIndex += 1) {
        const binding = this.node(bodyNode);
        if (binding.tag !== FunctionalCoreTag.PatternBind) {
          throw new Error(
            `functional WasmGC backend case arm ${armIndex} has ${bindingIndex} bindings before tag ${binding.tag}; expected ${arity}`,
          );
        }
        this.#instructions.localGet(scrutineeLocal);
        this.#instructions.refAsNonNull();
        this.#instructions.structGet(VALUE_FIELDS_FIELD);
        this.#instructions.i32Const(arity - bindingIndex - 1);
        this.#instructions.arrayGet();
        const fieldLocal = this.#instructions.addValueLocal();
        this.#instructions.localSet(fieldLocal);
        armEnvironment = [fieldLocal, ...armEnvironment];
        bodyNode = binding.child0;
      }
      this.emitExpression(bodyNode, armEnvironment);
      this.#instructions.else();
      openArmCount += 1;
      armIndex = arm.child1;
    }
    this.#instructions.unreachable();
    for (let index = 0; index < openArmCount; index += 1) this.#instructions.end();
  }

  emitPayload(nodeIndex: number, environment: readonly number[]): void {
    this.emitExpression(nodeIndex, environment);
    this.#instructions.structGet(VALUE_PAYLOAD_FIELD);
  }

  emitNumericField(
    nodeIndex: number,
    environment: readonly number[],
    group: NumericPrimitiveKind,
  ): void {
    this.emitExpression(nodeIndex, environment);
    this.#instructions.structGet(
      group === "integer"
        ? VALUE_PAYLOAD_FIELD
        : group === "signed-integer-64"
        ? VALUE_I64_FIELD
        : group === "float-32"
        ? VALUE_F32_FIELD
        : VALUE_F64_FIELD,
    );
  }

  emitNumericValue(
    group: NumericPrimitiveKind,
    emitNumber: () => void,
    kindOverride?: number,
  ): void {
    const kind = kindOverride ??
      (group === "integer"
        ? FunctionalWasmGcValueKind.Integer
        : group === "signed-integer-64"
        ? FunctionalWasmGcValueKind.SignedInteger64
        : group === "float-32"
        ? FunctionalWasmGcValueKind.Float32
        : group === "float-64"
        ? FunctionalWasmGcValueKind.Float64
        : FunctionalWasmGcValueKind.WholeNumberF64);
    this.#instructions.i32Const(kind);
    if (group === "integer") {
      emitNumber();
      this.#instructions.i32Const(0);
      this.#instructions.i64Const(0n);
      this.#instructions.f32Const(0);
      this.#instructions.f64Const(0);
    } else if (group === "signed-integer-64") {
      this.#instructions.i32Const(0);
      this.#instructions.i32Const(0);
      emitNumber();
      this.#instructions.f32Const(0);
      this.#instructions.f64Const(0);
    } else if (group === "float-32") {
      this.#instructions.i32Const(0);
      this.#instructions.i32Const(0);
      this.#instructions.i64Const(0n);
      emitNumber();
      this.#instructions.f64Const(0);
    } else {
      this.#instructions.i32Const(0);
      this.#instructions.i32Const(0);
      this.#instructions.i64Const(0n);
      this.#instructions.f32Const(0);
      emitNumber();
    }
    this.#instructions.arrayNewFixed(0);
    this.#instructions.structNew();
  }

  emitLiteralValue(kind: number, payload: number): void {
    this.#instructions.i32Const(kind);
    this.#instructions.i32Const(payload);
    this.emitEmptyNumericFields();
    this.#instructions.arrayNewFixed(0);
    this.#instructions.structNew();
  }

  emitEmptyNumericFields(): void {
    this.#instructions.i32Const(0);
    this.#instructions.i64Const(0n);
    this.#instructions.f32Const(0);
    this.#instructions.f64Const(0);
  }

  emitStoreNew(
    nodeIndex: number,
    node: FunctionalCoreNode,
    environment: readonly number[],
  ): void {
    this.emitPayload(node.child0, environment);
    const length = this.#instructions.addI32Local();
    this.#instructions.localSet(length);
    this.emitExpression(node.child1, environment);
    const initial = this.#instructions.addValueLocal();
    this.#instructions.localSet(initial);
    this.requireStoreLength(length, nodeIndex);
    this.#instructions.i32Const(FunctionalWasmGcValueKind.Store);
    this.#instructions.i32Const(0);
    this.emitEmptyNumericFields();
    this.#instructions.localGet(initial);
    this.#instructions.refAsNonNull();
    this.#instructions.localGet(length);
    this.#instructions.arrayNew();
    this.#instructions.structNew();
  }

  emitStoreLength(node: FunctionalCoreNode, environment: readonly number[]): void {
    this.emitExpression(node.child0, environment);
    const store = this.#instructions.addValueLocal();
    this.#instructions.localSet(store);
    this.emitNumericValue("integer", () => {
      this.#instructions.localGet(store);
      this.#instructions.refAsNonNull();
      this.#instructions.structGet(VALUE_FIELDS_FIELD);
      this.#instructions.arrayLength();
    });
  }

  emitStoreRead(
    nodeIndex: number,
    node: FunctionalCoreNode,
    environment: readonly number[],
  ): void {
    this.emitExpression(node.child0, environment);
    const store = this.#instructions.addValueLocal();
    this.#instructions.localSet(store);
    this.emitPayload(node.child1, environment);
    const index = this.#instructions.addI32Local();
    this.#instructions.localSet(index);
    this.requireStoreIndex(store, index, nodeIndex);
    this.#instructions.localGet(store);
    this.#instructions.refAsNonNull();
    this.#instructions.structGet(VALUE_FIELDS_FIELD);
    this.#instructions.localGet(index);
    this.#instructions.arrayGet();
    this.#instructions.refAsNonNull();
  }

  emitStoreUpdates(nodeIndex: number, environment: readonly number[]): void {
    const updates: FunctionalStoreUpdate[] = [];
    let sourceNodeIndex = nodeIndex;
    while (true) {
      const sourceNode = this.node(sourceNodeIndex);
      if (
        sourceNode.tag !== FunctionalCoreTag.StoreWrite &&
        sourceNode.tag !== FunctionalCoreTag.StoreGrow
      ) break;
      updates.push({ node: sourceNode, nodeIndex: sourceNodeIndex });
      sourceNodeIndex = sourceNode.child0;
    }
    updates.reverse();

    this.emitExpression(sourceNodeIndex, environment);
    const store = this.#instructions.addValueLocal();
    this.#instructions.localSet(store);
    const sourceLength = this.#instructions.addI32Local();
    this.#instructions.localGet(store);
    this.#instructions.refAsNonNull();
    this.#instructions.structGet(VALUE_FIELDS_FIELD);
    this.#instructions.arrayLength();
    this.#instructions.localSet(sourceLength);
    const currentLength = this.#instructions.addI32Local();
    this.#instructions.localGet(sourceLength);
    this.#instructions.localSet(currentLength);
    const evaluated: ({
      readonly kind: "write";
      readonly index: number;
      readonly value: number;
    } | {
      readonly kind: "grow";
      readonly previousLength: number;
      readonly newLength: number;
      readonly initial: number;
    })[] = [];
    for (const update of updates) {
      this.emitPayload(update.node.child1, environment);
      const operand = this.#instructions.addI32Local();
      this.#instructions.localSet(operand);
      this.emitExpression(update.node.child2, environment);
      const value = this.#instructions.addValueLocal();
      this.#instructions.localSet(value);
      if (update.node.tag === FunctionalCoreTag.StoreWrite) {
        this.#instructions.localGet(operand);
        this.#instructions.localGet(currentLength);
        this.#instructions.emit(0x4f);
        this.emitStoreFaultWhenTrue(update.nodeIndex);
        evaluated.push({ kind: "write", index: operand, value });
        continue;
      }
      this.requireStoreLength(operand, update.nodeIndex);
      this.#instructions.localGet(currentLength);
      this.#instructions.localGet(operand);
      this.#instructions.emit(0x4b);
      this.emitStoreFaultWhenTrue(update.nodeIndex);
      const previousLength = this.#instructions.addI32Local();
      this.#instructions.localGet(currentLength);
      this.#instructions.localSet(previousLength);
      this.#instructions.localGet(operand);
      this.#instructions.localSet(currentLength);
      evaluated.push({
        kind: "grow",
        previousLength,
        newLength: operand,
        initial: value,
      });
    }

    const fields = this.#instructions.addFieldsLocal();
    const allocationInitial = evaluated.findLast((update) => update.kind === "grow") ??
      evaluated[0]!;
    this.#instructions.localGet(
      allocationInitial.kind === "grow" ? allocationInitial.initial : allocationInitial.value,
    );
    this.#instructions.refAsNonNull();
    this.#instructions.localGet(currentLength);
    this.#instructions.arrayNew();
    this.#instructions.localSet(fields);
    this.copyStoreFields(fields, store, sourceLength);
    for (const update of evaluated) {
      if (update.kind === "write") {
        this.#instructions.localGet(fields);
        this.#instructions.refAsNonNull();
        this.#instructions.localGet(update.index);
        this.#instructions.localGet(update.value);
        this.#instructions.refAsNonNull();
        this.#instructions.arraySet();
        continue;
      }
      this.emitStoreFill(
        fields,
        update.previousLength,
        update.newLength,
        update.initial,
      );
    }
    this.emitStoreValue(fields);
  }

  requireStoreLength(length: number, nodeIndex: number): void {
    this.#instructions.localGet(length);
    this.#instructions.i32Const(FUNCTIONAL_MAXIMUM_STORE_LENGTH);
    this.#instructions.emit(0x4b);
    this.emitStoreFaultWhenTrue(nodeIndex);
  }

  requireStoreIndex(store: number, index: number, nodeIndex: number): void {
    this.#instructions.localGet(index);
    this.#instructions.localGet(store);
    this.#instructions.refAsNonNull();
    this.#instructions.structGet(VALUE_FIELDS_FIELD);
    this.#instructions.arrayLength();
    this.#instructions.emit(0x4f);
    this.emitStoreFaultWhenTrue(nodeIndex);
  }

  emitStoreFaultWhenTrue(nodeIndex: number): void {
    this.#instructions.ifVoid();
    this.#instructions.i32Const(WASM_FAULT_OUT_OF_BOUNDS);
    this.#instructions.globalSet(this.#module.definitionCount + 1);
    this.#instructions.i32Const(nodeIndex);
    this.#instructions.globalSet(this.#module.definitionCount + 2);
    this.#instructions.unreachable();
    this.#instructions.end();
  }

  copyStoreFields(destination: number, store: number, length: number): void {
    this.#instructions.localGet(destination);
    this.#instructions.refAsNonNull();
    this.#instructions.i32Const(0);
    this.#instructions.localGet(store);
    this.#instructions.refAsNonNull();
    this.#instructions.structGet(VALUE_FIELDS_FIELD);
    this.#instructions.i32Const(0);
    this.#instructions.localGet(length);
    this.#instructions.arrayCopy();
  }

  emitStoreFill(fields: number, start: number, end: number, value: number): void {
    const cursor = this.#instructions.addI32Local();
    this.#instructions.localGet(start);
    this.#instructions.localSet(cursor);
    this.#instructions.emit(0x02, 0x40, 0x03, 0x40);
    this.#instructions.localGet(cursor);
    this.#instructions.localGet(end);
    this.#instructions.emit(0x4f, 0x0d, 0x01);
    this.#instructions.localGet(fields);
    this.#instructions.refAsNonNull();
    this.#instructions.localGet(cursor);
    this.#instructions.localGet(value);
    this.#instructions.refAsNonNull();
    this.#instructions.arraySet();
    this.#instructions.localGet(cursor);
    this.#instructions.i32Const(1);
    this.#instructions.emit(0x6a);
    this.#instructions.localSet(cursor);
    this.#instructions.emit(0x0c, 0x00, 0x0b, 0x0b);
  }

  emitStoreValue(fields: number): void {
    this.#instructions.i32Const(FunctionalWasmGcValueKind.Store);
    this.#instructions.i32Const(0);
    this.emitEmptyNumericFields();
    this.#instructions.localGet(fields);
    this.#instructions.refAsNonNull();
    this.#instructions.structNew();
  }

  constructorArity(constructorIndex: number, nodeIndex: number): number {
    const arity = this.#module.constructorArities[constructorIndex];
    if (arity === undefined) {
      throw new Error(
        `functional WasmGC backend constructor ${constructorIndex} at core node ${nodeIndex} exceeds ${this.#module.constructorCount} constructors`,
      );
    }
    return arity;
  }

  node(nodeIndex: number): FunctionalCoreNode {
    const node = this.#nodes[nodeIndex];
    if (node === undefined) {
      throw new Error(
        `functional WasmGC backend references core node ${nodeIndex} outside ${this.#nodes.length} nodes`,
      );
    }
    return node;
  }
}

class GcInstructions {
  readonly bytes: number[] = [];
  readonly localTypes: ("value" | "fields" | "i32")[] = [];
  readonly #parameterCount: number;

  constructor(parameterCount = 0) {
    this.#parameterCount = parameterCount;
  }

  addValueLocal(): number {
    const index = this.#parameterCount + this.localTypes.length;
    this.localTypes.push("value");
    return index;
  }

  addI32Local(): number {
    const index = this.#parameterCount + this.localTypes.length;
    this.localTypes.push("i32");
    return index;
  }

  addFieldsLocal(): number {
    const index = this.#parameterCount + this.localTypes.length;
    this.localTypes.push("fields");
    return index;
  }

  emit(...bytes: number[]): void {
    this.bytes.push(...bytes);
  }

  i32Const(value: number): void {
    this.emit(0x41, ...encodeSigned(BigInt(value | 0)));
  }

  i64Const(value: bigint): void {
    this.emit(0x42, ...encodeSigned(value));
  }

  f32Const(value: number): void {
    const bytes = new ArrayBuffer(4);
    new DataView(bytes).setFloat32(0, value, true);
    this.emit(0x43, ...new Uint8Array(bytes));
  }

  f64Const(value: number): void {
    const bytes = new ArrayBuffer(8);
    new DataView(bytes).setFloat64(0, value, true);
    this.emit(0x44, ...new Uint8Array(bytes));
  }

  localGet(index: number): void {
    this.emit(0x20, ...encodeUnsigned(index));
  }

  localSet(index: number): void {
    this.emit(0x21, ...encodeUnsigned(index));
  }

  globalGet(index: number): void {
    this.emit(0x23, ...encodeUnsigned(index));
  }

  globalSet(index: number): void {
    this.emit(0x24, ...encodeUnsigned(index));
  }

  call(index: number): void {
    this.emit(0x10, ...encodeUnsigned(index));
  }

  callIndirect(): void {
    this.emit(
      0x11,
      ...encodeUnsigned(CALL_TYPE_INDEX),
      ...encodeUnsigned(0),
    );
  }

  refNullValue(): void {
    this.emit(0xd0, ...encodeSigned(BigInt(VALUE_TYPE_INDEX)));
  }

  refAsNonNull(): void {
    this.emit(0xd4);
  }

  structNew(): void {
    this.emit(0xfb, ...encodeUnsigned(0), ...encodeUnsigned(VALUE_TYPE_INDEX));
  }

  structGet(fieldIndex: number): void {
    this.emit(
      0xfb,
      ...encodeUnsigned(2),
      ...encodeUnsigned(VALUE_TYPE_INDEX),
      ...encodeUnsigned(fieldIndex),
    );
  }

  structSet(fieldIndex: number): void {
    this.emit(
      0xfb,
      ...encodeUnsigned(5),
      ...encodeUnsigned(VALUE_TYPE_INDEX),
      ...encodeUnsigned(fieldIndex),
    );
  }

  arrayNewFixed(length: number): void {
    this.emit(
      0xfb,
      ...encodeUnsigned(8),
      ...encodeUnsigned(VALUE_FIELDS_TYPE_INDEX),
      ...encodeUnsigned(length),
    );
  }

  arrayNew(): void {
    this.emit(0xfb, ...encodeUnsigned(6), ...encodeUnsigned(VALUE_FIELDS_TYPE_INDEX));
  }

  arrayGet(): void {
    this.emit(0xfb, ...encodeUnsigned(11), ...encodeUnsigned(VALUE_FIELDS_TYPE_INDEX));
  }

  arraySet(): void {
    this.emit(0xfb, ...encodeUnsigned(14), ...encodeUnsigned(VALUE_FIELDS_TYPE_INDEX));
  }

  arrayCopy(): void {
    this.emit(
      0xfb,
      ...encodeUnsigned(17),
      ...encodeUnsigned(VALUE_FIELDS_TYPE_INDEX),
      ...encodeUnsigned(VALUE_FIELDS_TYPE_INDEX),
    );
  }

  arrayLength(): void {
    this.emit(0xfb, ...encodeUnsigned(15));
  }

  ifValue(): void {
    this.emit(0x04, 0x64, ...encodeSigned(BigInt(VALUE_TYPE_INDEX)));
  }

  ifVoid(): void {
    this.emit(0x04, 0x40);
  }

  else(): void {
    this.emit(0x05);
  }

  end(): void {
    this.emit(0x0b);
  }

  unreachable(): void {
    this.emit(0x00);
  }
}

function encodeGcModule(
  definitionCount: number,
  main: GcFunctionBody,
  initialize: GcFunctionBody,
  force: GcFunctionBody,
  workers: readonly GcFunctionBody[],
): Uint8Array<ArrayBuffer> {
  const valueFields = [
    [0x7f, 0x01],
    [0x7f, 0x01],
    [0x7f, 0x01],
    [0x7e, 0x01],
    [0x7d, 0x01],
    [0x7c, 0x01],
    [0x64, ...encodeSigned(BigInt(VALUE_FIELDS_TYPE_INDEX)), 0x01],
  ];
  const valueType = [0x5f, ...vector(valueFields)];
  const valueFieldsType = [
    0x5e,
    0x63,
    ...encodeSigned(BigInt(VALUE_TYPE_INDEX)),
    0x01,
  ];
  const valueTypes = [0x4e, ...vector([valueType, valueFieldsType])];
  const valueReference = [0x64, ...encodeSigned(BigInt(VALUE_TYPE_INDEX))];
  const mainType = [0x60, ...vector([]), ...vector([valueReference])];
  const callType = [
    0x60,
    ...vector([valueReference, valueReference]),
    ...vector([valueReference]),
  ];
  const initializeType = [0x60, ...vector([]), ...vector([])];
  const forceType = [0x60, ...vector([valueReference]), ...vector([valueReference])];
  const valueToI32Type = [0x60, ...vector([valueReference]), ...vector([[0x7f]])];
  const valueToI64Type = [0x60, ...vector([valueReference]), ...vector([[0x7e]])];
  const valueToF32Type = [0x60, ...vector([valueReference]), ...vector([[0x7d]])];
  const valueToF64Type = [0x60, ...vector([valueReference]), ...vector([[0x7c]])];
  const valueFieldType = [
    0x60,
    ...vector([valueReference, [0x7f]]),
    ...vector([valueReference]),
  ];
  const accessors = valueAccessorFunctions();
  const functions = [main, initialize, force, ...workers, ...accessors];
  const firstAccessorFunction = 3 + workers.length;

  const sections = [
    section(
      1,
      vector([
        valueTypes,
        mainType,
        callType,
        initializeType,
        forceType,
        valueToI32Type,
        valueToI64Type,
        valueToF32Type,
        valueToF64Type,
        valueFieldType,
      ]),
    ),
    section(3, vector(functions.map((body) => encodeUnsigned(body.typeIndex)))),
    ...(workers.length === 0
      ? []
      : [section(4, vector([[0x70, 0x00, ...encodeUnsigned(workers.length)]]))]),
    section(
      6,
      vector([
        ...Array.from(
          { length: definitionCount },
          () => [
            0x63,
            ...encodeSigned(BigInt(VALUE_TYPE_INDEX)),
            0x01,
            0xd0,
            ...encodeSigned(BigInt(VALUE_TYPE_INDEX)),
            0x0b,
          ],
        ),
        [0x7f, 0x01, 0x41, 0x00, 0x0b],
        [0x7f, 0x01, 0x41, 0x00, 0x0b],
        [0x7f, 0x01, 0x41, 0x7f, 0x0b],
        [
          0x7f,
          0x00,
          0x41,
          ...encodeSigned(BigInt(FUNCTIONAL_WASM_GC_ABI_VERSION)),
          0x0b,
        ],
      ]),
    ),
    section(
      7,
      vector([
        exportEntry("main", 0x00, 0),
        exportEntry("thunkEvaluations", 0x03, definitionCount),
        exportEntry("runtimeFault", 0x03, definitionCount + 1),
        exportEntry("runtimeFaultNode", 0x03, definitionCount + 2),
        exportEntry("wasmGcAbiVersion", 0x03, definitionCount + 3),
        exportEntry("valueKind", 0x00, firstAccessorFunction),
        exportEntry("valuePayload", 0x00, firstAccessorFunction + 1),
        exportEntry("valueSignedInteger64", 0x00, firstAccessorFunction + 2),
        exportEntry("valueFloat32", 0x00, firstAccessorFunction + 3),
        exportEntry("valueFloat64", 0x00, firstAccessorFunction + 4),
        exportEntry("valueFieldCount", 0x00, firstAccessorFunction + 5),
        exportEntry("valueField", 0x00, firstAccessorFunction + 6),
      ]),
    ),
    section(8, encodeUnsigned(1)),
    ...(workers.length === 0 ? [] : [section(
      9,
      vector([[
        0x00,
        0x41,
        0x00,
        0x0b,
        ...vector(workers.map((_, slot) => encodeUnsigned(slot + 3))),
      ]]),
    )]),
    section(10, vector(functions.map(encodeFunctionBody))),
  ];

  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...sections.flat(),
  ]);
}

function valueAccessorFunctions(): readonly GcFunctionBody[] {
  const scalarField = (
    typeIndex: number,
    fieldIndex: number,
  ): GcFunctionBody => {
    const instructions = new GcInstructions(1);
    instructions.localGet(0);
    instructions.structGet(fieldIndex);
    return { typeIndex, localTypes: [], instructions: instructions.bytes };
  };
  const fieldCount = new GcInstructions(1);
  fieldCount.localGet(0);
  fieldCount.structGet(VALUE_FIELDS_FIELD);
  fieldCount.arrayLength();
  const field = new GcInstructions(2);
  field.localGet(0);
  field.structGet(VALUE_FIELDS_FIELD);
  field.localGet(1);
  field.arrayGet();
  field.refAsNonNull();
  field.call(2);
  return [
    scalarField(VALUE_TO_I32_TYPE_INDEX, 0),
    scalarField(VALUE_TO_I32_TYPE_INDEX, VALUE_PAYLOAD_FIELD),
    scalarField(VALUE_TO_I64_TYPE_INDEX, VALUE_I64_FIELD),
    scalarField(VALUE_TO_F32_TYPE_INDEX, VALUE_F32_FIELD),
    scalarField(VALUE_TO_F64_TYPE_INDEX, VALUE_F64_FIELD),
    {
      typeIndex: VALUE_TO_I32_TYPE_INDEX,
      localTypes: [],
      instructions: fieldCount.bytes,
    },
    {
      typeIndex: VALUE_FIELD_TYPE_INDEX,
      localTypes: [],
      instructions: field.bytes,
    },
  ];
}

function encodeFunctionBody(body: GcFunctionBody): number[] {
  const encodedLocalGroups = body.localTypes.map((type) =>
    type === "i32" ? [1, 0x7f] : [
      1,
      0x63,
      ...encodeSigned(BigInt(type === "value" ? VALUE_TYPE_INDEX : VALUE_FIELDS_TYPE_INDEX)),
    ]
  );
  const contents = [...vector(encodedLocalGroups), ...body.instructions, 0x0b];
  return [...encodeUnsigned(contents.length), ...contents];
}

function section(sectionId: number, contents: readonly number[]): number[] {
  return [sectionId, ...encodeUnsigned(contents.length), ...contents];
}

function exportEntry(name: string, kind: number, index: number): number[] {
  const nameBytes = new TextEncoder().encode(name);
  return [
    ...encodeUnsigned(nameBytes.length),
    ...nameBytes,
    kind,
    ...encodeUnsigned(index),
  ];
}

function vector(values: readonly (readonly number[])[]): number[] {
  return [...encodeUnsigned(values.length), ...values.flat()];
}

function encodeUnsigned(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`WebAssembly unsigned integer must be non-negative; received ${value}`);
  }
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value = Math.floor(value / 128);
    bytes.push(value === 0 ? byte : byte | 0x80);
  } while (value !== 0);
  return bytes;
}

function encodeSigned(value: bigint): number[] {
  const bytes: number[] = [];
  while (true) {
    const byte = Number(value & 0x7fn);
    value >>= 7n;
    const signBit = (byte & 0x40) !== 0;
    if ((value === 0n && !signBit) || (value === -1n && signBit)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 0x80);
  }
}
