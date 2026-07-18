import type { GpuFunctionalModule } from "./compiler_module.ts";
import type {
  FunctionalWasmAsyncInit,
  FunctionalWasmHostValue,
  FunctionalWasmInit,
  FunctionalWasmInitBinding,
} from "./wasm_contract.ts";
import {
  cachedExecutableWasm,
  cachedFunctionalWasmArtifact,
  fuelInstrumentedWasm,
} from "./wasm_artifacts.ts";
import {
  functionalEntryName,
  functionalHostOperationError,
  FunctionalWasmBoundaryError,
  functionalWasmEntry,
  functionalWasmImports,
  FunctionalWasmRuntimeError,
  FunctionalWasmSuspension,
  hostFieldKey,
  invalidFunctionalWasmInit,
  throwFunctionalWasmTrap,
} from "./wasm_host_boundary.ts";
import { beginFunctionalWasmArena } from "./wasm_arena.ts";
import {
  decodeFunctionalWasmValue,
  describeFunctionalType,
  encodeFunctionalWasmValue,
  type FunctionalWasmValue,
  FunctionalWasmValueError,
  releaseEncodedFunctionalWasmValue,
} from "./wasm_value_codec.ts";

export type { FunctionalWasmValue } from "./wasm_value_codec.ts";

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

export interface FunctionalBoundedWasmExecution extends FunctionalWasmExecution {
  readonly semanticSteps: number;
}

export interface FunctionalWasmRunOptions {
  readonly init?: FunctionalWasmInit;
  readonly argument?: FunctionalWasmValue;
  readonly maximumResultNodes?: number;
  readonly argumentOwnership?: "bounded-borrow" | "ownership-transfer";
  readonly signal?: AbortSignal;
}

export interface FunctionalWasmAsyncRunOptions extends Omit<FunctionalWasmRunOptions, "init"> {
  readonly init: FunctionalWasmAsyncInit;
  readonly maximumSuspensions?: number;
}

export async function runFunctionalWasmModule(
  module: GpuFunctionalModule,
  options: FunctionalWasmRunOptions = {},
): Promise<FunctionalWasmExecution> {
  return await runFunctionalWasmAttempt(module, options, false);
}

export async function runBoundedFunctionalWasmModule(
  module: GpuFunctionalModule,
  maximumSteps: number,
  options: FunctionalWasmRunOptions = {},
): Promise<FunctionalBoundedWasmExecution> {
  if (!Number.isSafeInteger(maximumSteps) || maximumSteps < 1 || maximumSteps > 1_000_000) {
    throw new RangeError(
      `bounded functional WASM maximumSteps must be within [1, 1000000]; received ${maximumSteps}`,
    );
  }
  const execution = await runFunctionalWasmAttempt(module, options, false, maximumSteps);
  if (execution.semanticSteps === undefined) {
    throw new Error("bounded functional WASM execution omitted its semantic step count");
  }
  return execution as FunctionalBoundedWasmExecution;
}

async function runFunctionalWasmAttempt(
  module: GpuFunctionalModule,
  options: FunctionalWasmRunOptions,
  allowSuspendingHostOperations: boolean,
  maximumSteps?: number,
): Promise<FunctionalWasmExecution & { readonly semanticSteps?: number }> {
  options.signal?.throwIfAborted();
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
            } is suspending; the direct WASM ABI is synchronous, so use runFunctionalWasmModuleAsync()`,
          );
        }
      }
    }
  }
  const nodes = await module.readCoreNodes();
  const entry = functionalWasmEntry(module);
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
  const argumentOwnership = options.argumentOwnership ?? "bounded-borrow";
  try {
    if (entry.parameter !== undefined) {
      if (options.argument === undefined) {
        throw new FunctionalWasmBoundaryError({
          code: "F4101",
          kind: "invalid-argument",
          path: "argument",
          message: `functional WASM entry requires ${
            describeFunctionalType(entry.parameter)
          } argument; received undefined`,
        });
      }
      try {
        argument = encodeFunctionalWasmValue(
          instance,
          module,
          entry.parameter,
          options.argument,
        );
      } catch (cause) {
        if (cause instanceof WebAssembly.RuntimeError) {
          throwFunctionalWasmTrap(module, nodes, instance, cause);
        }
        throw new FunctionalWasmBoundaryError({
          code: "F4101",
          kind: "invalid-argument",
          path: "argument",
          message: cause instanceof Error
            ? cause.message
            : `functional WASM argument encoding failed with ${String(cause)}`,
        }, cause);
      }
    } else if (options.argument !== undefined) {
      throw new FunctionalWasmBoundaryError({
        code: "F4101",
        kind: "invalid-argument",
        path: "argument",
        message: "functional WASM entry does not accept an argument",
      });
    }
    if (
      argumentOwnership !== "bounded-borrow" &&
      argumentOwnership !== "ownership-transfer"
    ) {
      throw new FunctionalWasmBoundaryError({
        code: "F4101",
        kind: "invalid-argument",
        path: "argumentOwnership",
        message:
          `functional WASM argumentOwnership must be bounded-borrow or ownership-transfer; received ${
            JSON.stringify(argumentOwnership)
          }`,
      });
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
    let value: FunctionalWasmValue;
    try {
      value = decodeFunctionalWasmValue(
        instance,
        module,
        entry.result,
        result,
        options.maximumResultNodes ?? 2_047,
      );
    } catch (cause) {
      if (cause instanceof FunctionalWasmValueError) {
        throw new FunctionalWasmRuntimeError({
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
      if (argument !== undefined && argumentOwnership === "ownership-transfer") {
        releaseEncodedFunctionalWasmValue(instance, argument);
      }
    } finally {
      invocationArena?.reset();
    }
  }
}

interface FunctionalWasmReplayRecord {
  readonly field: string;
  readonly argument: FunctionalWasmHostValue;
  readonly result: FunctionalWasmHostValue;
}

export async function runFunctionalWasmModuleAsync(
  module: GpuFunctionalModule,
  options: FunctionalWasmAsyncRunOptions,
): Promise<FunctionalWasmExecution> {
  const maximumSuspensions = options.maximumSuspensions ?? 1_024;
  if (!Number.isSafeInteger(maximumSuspensions) || maximumSuspensions < 1) {
    throw new RangeError(
      `functional WASM maximumSuspensions must be a positive safe integer; received ${maximumSuspensions}`,
    );
  }
  const records: FunctionalWasmReplayRecord[] = [];
  let cursor = 0;
  const init: Record<string, Record<string, FunctionalWasmInitBinding>> = {};
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
    const bindings: Record<string, FunctionalWasmInitBinding> = {};
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
            throw new FunctionalWasmRuntimeError({
              code: "F3102",
              kind: "async-replay-diverged",
              entryDefinition: module.entryDefinition,
              entryName: functionalEntryName(module),
              capability: capability.name,
              operation: declaration.name,
              message:
                `functional WASM suspension replay diverged at operation ${recordIndex}: expected ${
                  JSON.stringify(recorded.field)
                } with ${describeFunctionalWasmHostValue(recorded.argument)}, received ${
                  JSON.stringify(field)
                } with ${describeFunctionalWasmHostValue(argument)}`,
            });
          }
          return copyFunctionalWasmHostValue(recorded.result);
        }
        if (recordIndex !== records.length) {
          throw new FunctionalWasmRuntimeError({
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
          | FunctionalWasmHostValue
          | PromiseLike<FunctionalWasmHostValue>;
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
              records.push({
                field,
                argument: stableArgument,
                result: copyFunctionalWasmHostValue(result),
              });
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
          throw new FunctionalWasmSuspension(pending);
        }
        records.push({
          field,
          argument: stableArgument,
          result: copyFunctionalWasmHostValue(returned),
        });
        return returned;
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
      return await runFunctionalWasmAttempt(
        module,
        {
          ...options,
          init,
        },
        true,
      );
    } catch (error) {
      if (!(error instanceof FunctionalWasmSuspension)) throw error;
      if (suspensionCount === maximumSuspensions) {
        throw new FunctionalWasmRuntimeError({
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
  left: FunctionalWasmHostValue,
  right: FunctionalWasmHostValue,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unit") return true;
  if (left.kind === "resource" && right.kind === "resource") {
    return left.id === right.id;
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
  value: FunctionalWasmHostValue,
): FunctionalWasmHostValue {
  if (value.kind === "bytes") {
    return { kind: "bytes", value: value.value.slice() };
  }
  if (value.kind === "tuple") {
    return {
      kind: "tuple",
      values: [
        copyFunctionalWasmHostValue(value.values[0]),
        copyFunctionalWasmHostValue(value.values[1]),
      ],
    };
  }
  if (value.kind === "array" || value.kind === "slice") {
    return {
      kind: value.kind,
      values: value.values.map(copyFunctionalWasmHostValue),
    };
  }
  if (value.kind === "constructor") {
    return {
      kind: "constructor",
      name: value.name,
      fields: value.fields.map(copyFunctionalWasmHostValue),
    };
  }
  return { ...value };
}

function describeFunctionalWasmHostValue(
  value: FunctionalWasmHostValue,
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
