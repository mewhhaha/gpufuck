import type { GpuModule } from "./compiler_module.ts";
import type { WasmAsyncInit, WasmHostValue, WasmInit, WasmInitBinding } from "./wasm_contract.ts";
import {
  cachedExecutableWasm,
  cachedFunctionalWasmArtifact,
  fuelInstrumentedWasm,
} from "./wasm_artifacts.ts";
import {
  functionalRuntimeTypeDescriptor,
  functionalRuntimeTypeDescriptorKey,
} from "./host_specialization.ts";
import {
  functionalEntryName,
  functionalHostOperationError,
  functionalWasmEntry,
  functionalWasmImports,
  hostFieldKey,
  invalidFunctionalWasmInit,
  throwFunctionalWasmTrap,
  WasmBoundaryError,
  WasmRuntimeError,
  WasmSuspension,
} from "./wasm_host_boundary.ts";
import { beginFunctionalWasmArena } from "./wasm_arena.ts";
import {
  decodeWasmValue,
  describeType,
  encodeWasmValue,
  releaseEncodedFunctionalWasmValue,
  type WasmValue,
  WasmValueError,
} from "./wasm_value_codec.ts";

export type { WasmValue } from "./wasm_value_codec.ts";

export interface WasmStats {
  readonly thunkEvaluations: number;
  readonly allocatedBytes: number;
  readonly specializedCallSites: number;
}

export interface WasmExecution {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly instance: WebAssembly.Instance;
  readonly value: WasmValue;
  readonly stats: WasmStats;
}

export interface BoundedWasmExecution extends WasmExecution {
  readonly semanticSteps: number;
}

export interface WasmRunOptions {
  readonly init?: WasmInit;
  readonly argument?: WasmValue;
  readonly maximumResultNodes?: number;
  readonly maximumResultBytes?: number;
  readonly argumentOwnership?: "bounded-borrow" | "ownership-transfer";
  readonly signal?: AbortSignal;
}

export interface WasmAsyncRunOptions extends Omit<WasmRunOptions, "init"> {
  readonly init: WasmAsyncInit;
  readonly maximumSuspensions?: number;
}

export async function runWasmModule(
  module: GpuModule,
  options: WasmRunOptions = {},
): Promise<WasmExecution> {
  return await runWasmAttempt(module, options, false);
}

export async function runBoundedFunctionalWasmModule(
  module: GpuModule,
  maximumSteps: number,
  options: WasmRunOptions = {},
): Promise<BoundedWasmExecution> {
  if (!Number.isSafeInteger(maximumSteps) || maximumSteps < 1 || maximumSteps > 1_000_000) {
    throw new RangeError(
      `bounded functional WASM maximumSteps must be within [1, 1000000]; received ${maximumSteps}`,
    );
  }
  const execution = await runWasmAttempt(module, options, false, maximumSteps);
  if (execution.semanticSteps === undefined) {
    throw new Error("bounded functional WASM execution omitted its semantic step count");
  }
  return execution as BoundedWasmExecution;
}

async function runWasmAttempt(
  module: GpuModule,
  options: WasmRunOptions,
  allowSuspendingHostOperations: boolean,
  maximumSteps?: number,
): Promise<WasmExecution & { readonly semanticSteps?: number }> {
  options.signal?.throwIfAborted();
  const { maximumResultNodes, maximumResultBytes } = validateFunctionalWasmRunControls(options);
  if (!allowSuspendingHostOperations) {
    for (const capability of module.hostCapabilities) {
      for (const declaration of capability.fields) {
        if (
          declaration.kind === "operation" &&
          declaration.execution === "suspending"
        ) {
          throw new TypeError(
            `functional WASM host operation ${
              JSON.stringify(`${capability.name}.${declaration.name}`)
            } is suspending; the direct WASM ABI is synchronous, so use runWasmModuleAsync()`,
          );
        }
      }
    }
  }
  const nodes = await module.readCoreNodes();
  const entry = functionalWasmEntry(module);
  if (entry.parameter !== undefined && options.argument === undefined) {
    throw new WasmBoundaryError({
      code: "F4101",
      kind: "invalid-argument",
      path: "argument",
      message: `functional WASM entry requires ${
        describeType(entry.parameter)
      } argument; received undefined`,
    });
  }
  if (entry.parameter === undefined && options.argument !== undefined) {
    throw new WasmBoundaryError({
      code: "F4101",
      kind: "invalid-argument",
      path: "argument",
      message: "functional WASM entry does not accept an argument",
    });
  }
  const instrumented = maximumSteps === undefined
    ? undefined
    : await fuelInstrumentedWasm(module, nodes);
  const [artifact, executable] = instrumented === undefined
    ? await Promise.all([cachedFunctionalWasmArtifact(module), cachedExecutableWasm(module)])
    : [instrumented, instrumented.executable] as const;
  options.signal?.throwIfAborted();
  const { bytes } = artifact;
  const host = functionalWasmImports(module, options.init);
  const instance = new WebAssembly.Instance(executable, host.imports);
  host.bindInstance(instance);
  const comptimeFuel = instance.exports.comptimeFuel;
  const comptimeSteps = instance.exports.comptimeSteps;
  if (maximumSteps !== undefined) {
    if (
      !(comptimeFuel instanceof WebAssembly.Global) ||
      !(comptimeSteps instanceof WebAssembly.Global)
    ) {
      throw new Error("fuel-instrumented functional WASM omitted its counter globals");
    }
    comptimeFuel.value = maximumSteps;
    comptimeSteps.value = 0;
  }
  const exportedMain = instance.exports.main;
  if (typeof exportedMain !== "function") {
    throw new Error(
      `functional WASM entry d${module.entryDefinition} did not export a callable main function`,
    );
  }
  const heapTop = instance.exports.heapTop;
  if (heapTop !== undefined && !(heapTop instanceof WebAssembly.Global)) {
    throw new Error(
      `functional WASM entry d${module.entryDefinition} exported a non-global allocator heap top`,
    );
  }
  const heapTopBeforeInitialization = heapTop instanceof WebAssembly.Global
    ? Number(heapTop.value) >>> 0
    : 0;
  if (heapTop instanceof WebAssembly.Global) {
    const initialize = instance.exports.initialize;
    if (typeof initialize !== "function") {
      throw new Error(
        "functional WASM runtime module omitted its initialize export",
      );
    }
    try {
      initialize();
    } catch (cause) {
      throwFunctionalWasmTrap(module, nodes, instance, cause);
    }
  }
  const invocationArena = heapTop instanceof WebAssembly.Global &&
      artifact.automaticArenaReset
    ? beginFunctionalWasmArena(instance)
    : undefined;
  let argument: bigint | undefined;
  try {
    if (entry.parameter !== undefined) {
      try {
        argument = encodeWasmValue(
          instance,
          module,
          entry.parameter,
          options.argument!,
        );
      } catch (cause) {
        if (cause instanceof WebAssembly.RuntimeError) {
          throwFunctionalWasmTrap(module, nodes, instance, cause);
        }
        throw new WasmBoundaryError({
          code: "F4101",
          kind: "invalid-argument",
          path: "argument",
          message: cause instanceof Error
            ? cause.message
            : `functional WASM argument encoding failed with ${String(cause)}`,
        }, cause);
      }
    }
    const heapBase = entry.parameter === undefined
      ? heapTopBeforeInitialization
      : heapTop instanceof WebAssembly.Global
      ? Number(heapTop.value) >>> 0
      : 0;
    let result: number | bigint;
    try {
      options.signal?.throwIfAborted();
      result = (argument === undefined ? exportedMain() : exportedMain(argument)) as
        | number
        | bigint;
    } catch (cause) {
      throwFunctionalWasmTrap(module, nodes, instance, cause);
    }
    let value: WasmValue;
    try {
      value = decodeWasmValue(
        instance,
        module,
        entry.result,
        result,
        maximumResultNodes,
        maximumResultBytes,
      );
    } catch (cause) {
      if (cause instanceof WasmValueError) {
        throw new WasmRuntimeError({
          code: cause.kind === "result-too-large" ? "F3010" : "F3011",
          kind: cause.kind,
          entryDefinition: module.entryDefinition,
          entryName: functionalEntryName(module),
          message: cause.message,
        }, cause);
      }
      throwFunctionalWasmTrap(module, nodes, instance, cause);
    }
    const thunkEvaluations = instance.exports.thunkEvaluations;
    if (
      thunkEvaluations !== undefined &&
      !(thunkEvaluations instanceof WebAssembly.Global)
    ) {
      throw new Error(
        `functional WASM entry d${module.entryDefinition} exported non-global thunk evaluation stats`,
      );
    }
    const finalHeapTop = heapTop instanceof WebAssembly.Global ? Number(heapTop.value) >>> 0 : 0;
    if (finalHeapTop < heapBase) {
      throw new Error(
        `functional WASM entry d${module.entryDefinition} wrapped its allocator heap top from ${heapBase} to ${finalHeapTop}`,
      );
    }
    return {
      bytes: bytes.slice(),
      instance,
      value,
      stats: {
        thunkEvaluations: thunkEvaluations instanceof WebAssembly.Global
          ? Number(thunkEvaluations.value)
          : 0,
        allocatedBytes: finalHeapTop - heapBase,
        specializedCallSites: artifact.specializedCallSites,
      },
      ...(comptimeSteps instanceof WebAssembly.Global
        ? { semanticSteps: Number(comptimeSteps.value) }
        : {}),
    };
  } finally {
    try {
      if (argument !== undefined && invocationArena === undefined) {
        releaseEncodedFunctionalWasmValue(instance, argument);
      }
    } finally {
      invocationArena?.reset();
    }
  }
}

function validateFunctionalWasmRunControls(
  options: Pick<
    WasmRunOptions,
    "argumentOwnership" | "maximumResultBytes" | "maximumResultNodes"
  >,
): { readonly maximumResultNodes: number; readonly maximumResultBytes: number } {
  const argumentOwnership = options.argumentOwnership ?? "bounded-borrow";
  if (
    argumentOwnership !== "bounded-borrow" &&
    argumentOwnership !== "ownership-transfer"
  ) {
    throw new WasmBoundaryError({
      code: "F4101",
      kind: "invalid-argument",
      path: "argumentOwnership",
      message:
        `functional WASM argumentOwnership must be bounded-borrow or ownership-transfer; received ${
          JSON.stringify(argumentOwnership)
        }`,
    });
  }
  const maximumResultNodes = options.maximumResultNodes ?? 2_047;
  if (!Number.isSafeInteger(maximumResultNodes) || maximumResultNodes < 1) {
    throw new RangeError(
      `functional WASM maximumResultNodes must be a positive safe integer; received ${maximumResultNodes}`,
    );
  }
  const maximumResultBytes = options.maximumResultBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maximumResultBytes) || maximumResultBytes < 1) {
    throw new RangeError(
      `functional WASM maximumResultBytes must be a positive safe integer; received ${maximumResultBytes}`,
    );
  }
  return { maximumResultNodes, maximumResultBytes };
}

interface WasmReplayRecord {
  readonly field: string;
  readonly argument: WasmHostValue;
  readonly result: WasmHostValue;
}

export async function runWasmModuleAsync(
  module: GpuModule,
  options: WasmAsyncRunOptions,
): Promise<WasmExecution> {
  const maximumSuspensions = options.maximumSuspensions ?? 1_024;
  if (!Number.isSafeInteger(maximumSuspensions) || maximumSuspensions < 1) {
    throw new RangeError(
      `functional WASM maximumSuspensions must be a positive safe integer; received ${maximumSuspensions}`,
    );
  }
  options.signal?.throwIfAborted();
  validateFunctionalWasmRunControls(options);
  const records: WasmReplayRecord[] = [];
  let cursor = 0;
  const init: Record<string, Record<string, WasmInitBinding>> = {};
  for (const capability of module.hostCapabilities) {
    const externalFields = capability.fields.filter((declaration) => {
      if (declaration.kind === "value") {
        return declaration.wasmLiteral === undefined;
      }
      return declaration.wasmIntrinsic === undefined;
    });
    if (externalFields.length === 0) continue;
    const suppliedCapability = options.init[capability.name];
    if (suppliedCapability === undefined) {
      throw invalidFunctionalWasmInit(
        capability.name,
        `functional WASM async init omitted capability ${JSON.stringify(capability.name)}`,
      );
    }
    const bindings: Record<string, WasmInitBinding> = {};
    init[capability.name] = bindings;
    for (const declaration of externalFields) {
      const supplied = suppliedCapability[declaration.name];
      const field = hostFieldKey(capability.name, declaration.name);
      if (declaration.kind === "value") {
        if (supplied === undefined || typeof supplied === "function") {
          throw invalidFunctionalWasmInit(
            field,
            `functional WASM async init omitted value ${JSON.stringify(field)}`,
          );
        }
        bindings[declaration.name] = supplied;
        continue;
      }
      if (typeof supplied !== "function") {
        throw invalidFunctionalWasmInit(
          field,
          `functional WASM async init omitted operation ${JSON.stringify(field)}`,
        );
      }
      bindings[declaration.name] = (argument) => {
        const recordIndex = cursor;
        cursor += 1;
        const recorded = records[recordIndex];
        if (recorded !== undefined) {
          if (
            recorded.field !== field ||
            !sameFunctionalWasmHostValue(recorded.argument, argument)
          ) {
            throw new WasmRuntimeError({
              code: "F3102",
              kind: "async-replay-diverged",
              entryDefinition: module.entryDefinition,
              entryName: functionalEntryName(module),
              capability: capability.name,
              operation: declaration.name,
              message:
                `functional WASM suspension replay diverged at operation ${recordIndex}: expected ${
                  JSON.stringify(recorded.field)
                } with ${describeWasmHostValue(recorded.argument)}, received ${
                  JSON.stringify(field)
                } with ${describeWasmHostValue(argument)}`,
            });
          }
          return copyFunctionalWasmHostValue(recorded.result);
        }
        if (recordIndex !== records.length) {
          throw new WasmRuntimeError({
            code: "F3102",
            kind: "async-replay-diverged",
            entryDefinition: module.entryDefinition,
            entryName: functionalEntryName(module),
            capability: capability.name,
            operation: declaration.name,
            message: `functional WASM suspension replay omitted operation ${recordIndex}`,
          });
        }
        const stableArgument = copyFunctionalWasmHostValue(argument);
        let returned:
          | WasmHostValue
          | PromiseLike<WasmHostValue>;
        try {
          returned = supplied(argument);
        } catch (cause) {
          throw functionalHostOperationError(
            module,
            capability.name,
            declaration.name,
            cause,
          );
        }
        if (
          returned !== null && typeof returned === "object" &&
          "then" in returned
        ) {
          const pending = Promise.resolve(returned).then(
            (result) => {
              try {
                records.push({
                  field,
                  argument: stableArgument,
                  result: copyFunctionalWasmHostValue(result),
                });
              } catch (cause) {
                throw functionalHostOperationError(
                  module,
                  capability.name,
                  declaration.name,
                  cause,
                );
              }
            },
            (cause) => {
              throw functionalHostOperationError(
                module,
                capability.name,
                declaration.name,
                cause,
              );
            },
          );
          throw new WasmSuspension(pending);
        }
        let stableResult: WasmHostValue;
        try {
          stableResult = copyFunctionalWasmHostValue(returned);
        } catch (cause) {
          throw functionalHostOperationError(
            module,
            capability.name,
            declaration.name,
            cause,
          );
        }
        records.push({ field, argument: stableArgument, result: stableResult });
        return stableResult;
      };
    }
  }
  for (
    let suspensionCount = 0;
    suspensionCount <= maximumSuspensions;
    suspensionCount++
  ) {
    cursor = 0;
    try {
      return await runWasmAttempt(
        module,
        {
          ...options,
          init,
        },
        true,
      );
    } catch (error) {
      if (!(error instanceof WasmSuspension)) throw error;
      if (suspensionCount === maximumSuspensions) {
        throw new WasmRuntimeError({
          code: "F3104",
          kind: "suspension-limit",
          entryDefinition: module.entryDefinition,
          entryName: functionalEntryName(module),
          message: `functional WASM execution exceeded maximumSuspensions ${maximumSuspensions}`,
        });
      }
      await awaitFunctionalWasmSuspension(error.pending, options.signal);
    }
  }
  throw new Error("functional WASM suspension loop exited without a result");
}

function awaitFunctionalWasmSuspension(
  pending: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (cause) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}

function sameFunctionalWasmHostValue(
  left: WasmHostValue,
  right: WasmHostValue,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unit") return true;
  if (left.kind === "resource" && right.kind === "resource") {
    return left.id === right.id;
  }
  if (left.kind === "erased" && right.kind === "erased") {
    return functionalRuntimeTypeDescriptorKey(left.type) ===
        functionalRuntimeTypeDescriptorKey(right.type) &&
      sameFunctionalWasmHostValue(left.value, right.value);
  }
  if (left.kind === "bytes" && right.kind === "bytes") {
    if (left.value.length !== right.value.length) return false;
    return left.value.every((value, index) => value === right.value[index]);
  }
  if (left.kind === "tuple" && right.kind === "tuple") {
    return sameFunctionalWasmHostValue(left.values[0], right.values[0]) &&
      sameFunctionalWasmHostValue(left.values[1], right.values[1]);
  }
  if (
    (left.kind === "array" && right.kind === "array") ||
    (left.kind === "slice" && right.kind === "slice")
  ) {
    return left.values.length === right.values.length &&
      left.values.every((value, index) => {
        const other = right.values[index];
        return other !== undefined && sameFunctionalWasmHostValue(value, other);
      });
  }
  if (left.kind === "constructor" && right.kind === "constructor") {
    return left.name === right.name &&
      left.fields.length === right.fields.length &&
      left.fields.every((value, index) => {
        const other = right.fields[index];
        return other !== undefined && sameFunctionalWasmHostValue(value, other);
      });
  }
  if ("value" in left && "value" in right) {
    return Object.is(left.value, right.value);
  }
  return false;
}

function copyFunctionalWasmHostValue(
  value: WasmHostValue,
): WasmHostValue {
  type CopyFrame =
    | { readonly kind: "value"; readonly value: WasmHostValue }
    | {
      readonly kind: "aggregate";
      readonly value: Extract<
        WasmHostValue,
        { readonly kind: "tuple" | "array" | "slice" | "constructor" | "erased" }
      >;
      readonly childCount: number;
    };
  const pending: CopyFrame[] = [{ kind: "value", value }];
  const copiedValues: WasmHostValue[] = [];
  const activeValues = new WeakSet<object>();
  while (pending.length !== 0) {
    const frame = pending.pop()!;
    if (frame.kind === "aggregate") {
      const firstChild = copiedValues.length - frame.childCount;
      if (firstChild < 0) {
        throw new Error(
          `functional WASM async snapshot expected ${frame.childCount} children; received ${copiedValues.length}`,
        );
      }
      const children = copiedValues.splice(firstChild, frame.childCount);
      activeValues.delete(frame.value);
      if (frame.value.kind === "tuple") {
        const first = children[0];
        const second = children[1];
        if (first === undefined || second === undefined) {
          throw new Error("functional WASM async snapshot omitted a tuple field");
        }
        copiedValues.push({ kind: "tuple", values: [first, second] });
      } else if (frame.value.kind === "constructor") {
        copiedValues.push({
          kind: "constructor",
          name: frame.value.name,
          fields: children,
        });
      } else if (frame.value.kind === "erased") {
        copiedValues.push({
          kind: "erased",
          type: functionalRuntimeTypeDescriptor(frame.value.type),
          value: children[0]!,
        });
      } else {
        copiedValues.push({ kind: frame.value.kind, values: children });
      }
      continue;
    }

    const current = frame.value;
    if (current.kind === "bytes") {
      copiedValues.push({ kind: "bytes", value: current.value.slice() });
      continue;
    }
    if (
      current.kind !== "tuple" && current.kind !== "array" && current.kind !== "slice" &&
      current.kind !== "constructor" && current.kind !== "erased"
    ) {
      copiedValues.push({ ...current });
      continue;
    }
    if (activeValues.has(current)) {
      throw new TypeError(`functional WASM async snapshot contains a cyclic ${current.kind} value`);
    }
    activeValues.add(current);
    const children = current.kind === "constructor"
      ? current.fields
      : current.kind === "erased"
      ? [current.value]
      : current.values;
    pending.push({
      kind: "aggregate",
      value: current,
      childCount: children.length,
    });
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({ kind: "value", value: children[index]! });
    }
  }
  if (copiedValues.length !== 1) {
    throw new Error(
      `functional WASM async snapshot produced ${copiedValues.length} roots; expected 1`,
    );
  }
  return copiedValues[0]!;
}

function describeWasmHostValue(
  value: WasmHostValue,
): string {
  try {
    return JSON.stringify(value, (_key, member: unknown) => {
      if (typeof member === "bigint") return `${member}n`;
      if (member instanceof Uint8Array) return [...member];
      return member;
    });
  } catch {
    return `value with kind ${JSON.stringify(value.kind)}`;
  }
}
