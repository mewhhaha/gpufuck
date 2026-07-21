import { FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, FUNCTIONAL_UNIT_CONSTRUCTOR_NAME } from "./abi.ts";
import type { GpuFunctionalModule } from "./compiler_module.ts";
import { cachedFunctionalWasmGcArtifact } from "./wasm_artifacts.ts";
import type { FunctionalWasmExecution } from "./wasm_execution.ts";
import { FUNCTIONAL_WASM_GC_ABI_VERSION, FunctionalWasmGcValueKind } from "./wasm_gc_contract.ts";
import {
  functionalEntryName,
  FunctionalWasmRuntimeError,
  throwFunctionalWasmTrap,
} from "./wasm_host_boundary.ts";
import type { FunctionalWasmValue } from "./wasm_value_codec.ts";

const executableWasmGcByModule = new WeakMap<
  GpuFunctionalModule,
  Promise<WebAssembly.Module>
>();

export interface FunctionalWasmGcRunOptions {
  readonly maximumResultNodes?: number;
  readonly signal?: AbortSignal;
}

interface FunctionalWasmGcExports extends WebAssembly.Exports {
  readonly main: CallableFunction;
  readonly valueKind: CallableFunction;
  readonly valuePayload: CallableFunction;
  readonly valueSignedInteger64: CallableFunction;
  readonly valueFloat32: CallableFunction;
  readonly valueFloat64: CallableFunction;
  readonly valueFieldCount: CallableFunction;
  readonly valueField: CallableFunction;
  readonly thunkEvaluations: WebAssembly.Global;
  readonly wasmGcAbiVersion: WebAssembly.Global;
}

interface PendingValue {
  readonly reference: unknown;
  readonly path: string;
  readonly assign: (value: FunctionalWasmValue) => void;
}

type DecodeStep =
  | { readonly kind: "value"; readonly pending: PendingValue }
  | { readonly kind: "leave"; readonly reference: unknown };

export async function runFunctionalWasmGcModule(
  module: GpuFunctionalModule,
  options: FunctionalWasmGcRunOptions = {},
): Promise<FunctionalWasmExecution> {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("functional WasmGC run options must be an object");
  }
  const maximumResultNodes = options.maximumResultNodes ?? 2_047;
  if (!Number.isSafeInteger(maximumResultNodes) || maximumResultNodes < 1) {
    throw new RangeError(
      `functional WasmGC maximumResultNodes must be a positive safe integer; received ${maximumResultNodes}`,
    );
  }
  options.signal?.throwIfAborted();
  const artifact = await cachedFunctionalWasmGcArtifact(module);
  const { bytes, nodes } = artifact;
  let executableCompilation = executableWasmGcByModule.get(module);
  if (executableCompilation === undefined) {
    executableCompilation = Promise.resolve().then(() => new WebAssembly.Module(bytes));
    executableWasmGcByModule.set(module, executableCompilation);
  }
  let executable: WebAssembly.Module;
  try {
    executable = await executableCompilation;
  } catch (cause) {
    if (executableWasmGcByModule.get(module) === executableCompilation) {
      executableWasmGcByModule.delete(module);
    }
    throw new TypeError(
      "functional WasmGC backend requires a WebAssembly engine with the finalized GC extension",
      { cause },
    );
  }
  options.signal?.throwIfAborted();
  const instance = new WebAssembly.Instance(executable);
  const exports = requireFunctionalWasmGcExports(instance);
  let reference: unknown;
  try {
    reference = exports.main();
  } catch (cause) {
    throwFunctionalWasmTrap(module, nodes, instance, cause);
  }
  let value: FunctionalWasmValue;
  try {
    value = decodeFunctionalWasmGcValue(
      module,
      exports,
      reference,
      maximumResultNodes,
    );
  } catch (cause) {
    throwFunctionalWasmTrap(module, nodes, instance, cause);
  }
  return {
    bytes: bytes.slice(),
    instance,
    value,
    stats: {
      thunkEvaluations: Number(exports.thunkEvaluations.value),
      allocatedBytes: 0,
      specializedCallSites: 0,
    },
  };
}

function requireFunctionalWasmGcExports(
  instance: WebAssembly.Instance,
): FunctionalWasmGcExports {
  const requiredFunctions = [
    "main",
    "valueKind",
    "valuePayload",
    "valueSignedInteger64",
    "valueFloat32",
    "valueFloat64",
    "valueFieldCount",
    "valueField",
  ] as const;
  for (const name of requiredFunctions) {
    if (typeof instance.exports[name] !== "function") {
      throw new Error(`functional WasmGC artifact omitted callable export ${JSON.stringify(name)}`);
    }
  }
  if (!(instance.exports.thunkEvaluations instanceof WebAssembly.Global)) {
    throw new Error("functional WasmGC artifact omitted its thunk evaluation global");
  }
  if (!(instance.exports.wasmGcAbiVersion instanceof WebAssembly.Global)) {
    throw new Error("functional WasmGC artifact omitted its ABI version global");
  }
  if (Number(instance.exports.wasmGcAbiVersion.value) !== FUNCTIONAL_WASM_GC_ABI_VERSION) {
    throw new Error(
      `functional WasmGC artifact ABI version ${
        String(instance.exports.wasmGcAbiVersion.value)
      } does not match runtime version ${FUNCTIONAL_WASM_GC_ABI_VERSION}`,
    );
  }
  return instance.exports as unknown as FunctionalWasmGcExports;
}

function decodeFunctionalWasmGcValue(
  module: GpuFunctionalModule,
  exports: FunctionalWasmGcExports,
  rootReference: unknown,
  maximumResultNodes: number,
): FunctionalWasmValue {
  let result: FunctionalWasmValue | undefined;
  let decodedNodes = 0;
  const activeReferences = new Set<unknown>();
  const steps: DecodeStep[] = [{
    kind: "value",
    pending: {
      reference: rootReference,
      path: "$",
      assign: (value) => {
        result = value;
      },
    },
  }];

  while (steps.length !== 0) {
    const step = steps.pop()!;
    if (step.kind === "leave") {
      activeReferences.delete(step.reference);
      continue;
    }
    const { reference, path, assign } = step.pending;
    if (activeReferences.has(reference)) {
      throw new FunctionalWasmRuntimeError({
        code: "F3011",
        kind: "cyclic-result",
        entryDefinition: module.entryDefinition,
        entryName: functionalEntryName(module),
        message: `functional WasmGC result contains a structural cycle at ${path}`,
      });
    }
    decodedNodes += 1;
    if (decodedNodes > maximumResultNodes) {
      throw new FunctionalWasmRuntimeError({
        code: "F3010",
        kind: "result-too-large",
        entryDefinition: module.entryDefinition,
        entryName: functionalEntryName(module),
        message: `functional WasmGC result exceeds maximumResultNodes ${maximumResultNodes}`,
      });
    }
    const kind = Number(exports.valueKind(reference));
    if (kind === FunctionalWasmGcValueKind.Integer) {
      const value = { kind: "integer", value: Number(exports.valuePayload(reference)) } as const;
      assign(value);
      continue;
    }
    if (kind === FunctionalWasmGcValueKind.Boolean) {
      const value = { kind: "boolean", value: exports.valuePayload(reference) !== 0 } as const;
      assign(value);
      continue;
    }
    if (kind === FunctionalWasmGcValueKind.SignedInteger64) {
      const value = {
        kind: "signed-integer-64",
        value: BigInt(exports.valueSignedInteger64(reference)),
      } as const;
      assign(value);
      continue;
    }
    if (kind === FunctionalWasmGcValueKind.Float32) {
      const value = { kind: "float-32", value: Number(exports.valueFloat32(reference)) } as const;
      assign(value);
      continue;
    }
    if (
      kind === FunctionalWasmGcValueKind.Float64 ||
      kind === FunctionalWasmGcValueKind.WholeNumberF64
    ) {
      const value = { kind: "float-64", value: Number(exports.valueFloat64(reference)) } as const;
      assign(value);
      continue;
    }
    if (kind !== FunctionalWasmGcValueKind.Constructor) {
      throw new FunctionalWasmRuntimeError({
        code: "F3103",
        kind: "trap",
        entryDefinition: module.entryDefinition,
        entryName: functionalEntryName(module),
        message: `functional WasmGC result at ${path} has private value kind ${kind}`,
      });
    }

    const constructorIndex = Number(exports.valuePayload(reference));
    const constructorName = module.constructorNames[constructorIndex];
    const expectedArity = module.constructorArities[constructorIndex];
    const fieldCount = Number(exports.valueFieldCount(reference));
    if (constructorName === undefined || expectedArity === undefined) {
      throw new Error(
        `functional WasmGC result at ${path} references constructor ${constructorIndex} outside ${module.constructorCount} constructors`,
      );
    }
    if (fieldCount !== expectedArity) {
      throw new Error(
        `functional WasmGC result constructor ${
          JSON.stringify(constructorName)
        } at ${path} has ${fieldCount} fields; expected ${expectedArity}`,
      );
    }
    if (constructorName === FUNCTIONAL_UNIT_CONSTRUCTOR_NAME) {
      const value = { kind: "unit" } as const;
      assign(value);
      continue;
    }

    const fields: FunctionalWasmValue[] = new Array(fieldCount);
    const value: FunctionalWasmValue = constructorName === FUNCTIONAL_PAIR_CONSTRUCTOR_NAME
      ? {
        kind: "tuple",
        values: fields as unknown as [FunctionalWasmValue, FunctionalWasmValue],
      }
      : { kind: "constructor", name: constructorName, fields };
    assign(value);
    activeReferences.add(reference);
    steps.push({ kind: "leave", reference });
    for (let fieldIndex = fieldCount - 1; fieldIndex >= 0; fieldIndex -= 1) {
      steps.push({
        kind: "value",
        pending: {
          reference: exports.valueField(reference, fieldIndex),
          path: `${path}.fields[${fieldIndex}]`,
          assign: (fieldValue) => {
            fields[fieldIndex] = fieldValue;
          },
        },
      });
    }
  }
  if (result === undefined) {
    throw new Error("functional WasmGC result decoder completed without a root value");
  }
  return result;
}
