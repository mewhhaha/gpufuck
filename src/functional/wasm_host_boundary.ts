import {
  FUNCTIONAL_ERASED_TYPE_NAME,
  FUNCTIONAL_INIT_TYPE_NAME,
  type FunctionalHostScalarType,
  type FunctionalHostType,
} from "./host_contract.ts";
import type { FunctionalCoreNode, GpuFunctionalModule } from "./compiler_module.ts";
import type { FunctionalType } from "./abi.ts";
import type {
  FunctionalWasmBoundaryErrorDetails,
  FunctionalWasmHostValue,
  FunctionalWasmInit,
  FunctionalWasmInitBinding,
  FunctionalWasmRuntimeErrorDetails,
} from "./wasm_contract.ts";
import { locateFunctionalSpan } from "./diagnostics.ts";
import { functionalRuntimeTypeDescriptorKey } from "./host_specialization.ts";
import { WasmValueType } from "./wasm_binary.ts";
import {
  WASM_FAULT_BLACKHOLE,
  WASM_FAULT_DIVIDE_BY_ZERO,
  WASM_FAULT_EXPLICIT,
  WASM_FAULT_INVALID_NUMERIC_CONVERSION,
  WASM_FAULT_OUT_OF_BOUNDS,
  WASM_FAULT_OUT_OF_FUEL,
  WASM_FAULT_OUT_OF_MEMORY,
} from "./wasm_runtime_binary.ts";
import {
  concreteFunctionalType,
  decodeFunctionalWasmBoxedValue,
  decodeFunctionalWasmValue,
  describeFunctionalType,
  encodeFunctionalWasmValue,
  requireFirstOrderFunctionalWasmType,
} from "./wasm_value_codec.ts";

const HOST_IMPORT_MODULE_PREFIX = "functional_init:";

export interface FunctionalWasmEntry {
  readonly takesInit: boolean;
  readonly parameter?: FunctionalType;
  readonly result: FunctionalType;
}

export class FunctionalWasmBoundaryError extends TypeError {
  readonly code: FunctionalWasmBoundaryErrorDetails["code"];
  readonly kind: FunctionalWasmBoundaryErrorDetails["kind"];
  readonly path: string | undefined;

  constructor(details: FunctionalWasmBoundaryErrorDetails, cause?: unknown) {
    super(`${details.code}: ${details.message}`, { cause });
    this.name = "FunctionalWasmBoundaryError";
    this.code = details.code;
    this.kind = details.kind;
    this.path = details.path;
  }
}

export class FunctionalWasmRuntimeError extends Error {
  readonly code: FunctionalWasmRuntimeErrorDetails["code"];
  readonly kind: FunctionalWasmRuntimeErrorDetails["kind"];
  readonly entryDefinition: number;
  readonly entryName: string;
  readonly coreNode: number | undefined;
  readonly span: FunctionalWasmRuntimeErrorDetails["span"] | undefined;
  readonly location: FunctionalWasmRuntimeErrorDetails["location"] | undefined;
  readonly capability: string | undefined;
  readonly operation: string | undefined;

  constructor(entryDefinition: number, cause: unknown);
  constructor(details: FunctionalWasmRuntimeErrorDetails, cause?: unknown);
  constructor(
    detailsOrEntryDefinition: FunctionalWasmRuntimeErrorDetails | number,
    cause?: unknown,
  ) {
    const details: FunctionalWasmRuntimeErrorDetails = typeof detailsOrEntryDefinition === "number"
      ? {
        code: "F3005",
        kind: "blackhole",
        entryDefinition: detailsOrEntryDefinition,
        entryName: `d${detailsOrEntryDefinition}`,
        message:
          `functional WASM entry d${detailsOrEntryDefinition} recursively forced an evaluating thunk`,
      }
      : detailsOrEntryDefinition;
    super(`${details.code}: ${details.message}`, { cause });
    this.name = "FunctionalWasmRuntimeError";
    this.code = details.code;
    this.kind = details.kind;
    this.entryDefinition = details.entryDefinition;
    this.entryName = details.entryName;
    this.coreNode = details.coreNode;
    this.span = details.span;
    this.location = details.location;
    this.capability = details.capability;
    this.operation = details.operation;
  }
}

export class FunctionalWasmSuspension extends Error {
  constructor(readonly pending: Promise<void>) {
    super("functional WASM host operation suspended");
  }
}

export function wasmValueType(type: FunctionalHostType): number {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return WasmValueType.I32;
    case "signed-integer-64":
      return WasmValueType.I64;
    case "float-32":
      return WasmValueType.F32;
    case "float-64":
      return WasmValueType.F64;
    case "tuple":
    case "named":
      return WasmValueType.I64;
    case "parameter":
    case "function":
    case "forall":
      throw new TypeError(
        `functional WASM host type ${type.kind} is not concrete first-order`,
      );
  }
}

export function functionalWasmEntry(module: GpuFunctionalModule): FunctionalWasmEntry {
  const requiresInit = module.hostCapabilities.some((capability) =>
    capability.fields.some((field) =>
      !module.hostDefinitions.some((binding) =>
        binding.capability === capability.name && binding.field === field.name
      )
    )
  );
  if (module.entryType.kind !== "function") {
    if (requiresInit) {
      throw new TypeError(
        `functional WASM entry d${module.entryDefinition} declares ${module.hostCapabilities.length} host capabilities but does not accept ${FUNCTIONAL_INIT_TYPE_NAME}`,
      );
    }
    requireFirstOrderFunctionalWasmType(
      module,
      module.entryType,
      "entry result",
    );
    return { takesInit: false, result: module.entryType };
  }
  const parameter = module.entryType.parameter;
  const takesInit = parameter.kind === "named" &&
    parameter.name === FUNCTIONAL_INIT_TYPE_NAME &&
    parameter.arguments.length === 0;
  if (module.entryType.result.kind === "function") {
    throw unsupportedWasmEntryType(module, module.entryType);
  }
  if (takesInit) {
    if (module.hostCapabilities.length === 0) {
      throw new TypeError(
        `functional WASM entry d${module.entryDefinition} accepts ${FUNCTIONAL_INIT_TYPE_NAME} but declares no host capabilities`,
      );
    }
    requireFirstOrderFunctionalWasmType(
      module,
      module.entryType.result,
      "entry result",
    );
    return { takesInit: true, result: module.entryType.result };
  }
  if (requiresInit) {
    throw new TypeError(
      `functional WASM entry d${module.entryDefinition} declares host capabilities but accepts ${
        describeFunctionalType(parameter)
      } instead of ${FUNCTIONAL_INIT_TYPE_NAME}`,
    );
  }
  requireFirstOrderFunctionalWasmType(module, parameter, "entry argument");
  requireFirstOrderFunctionalWasmType(
    module,
    module.entryType.result,
    "entry result",
  );
  return { takesInit: false, parameter, result: module.entryType.result };
}

export function functionalEntryName(module: GpuFunctionalModule): string {
  return module.definitionNames[module.entryDefinition] ??
    `d${module.entryDefinition}`;
}

function functionalWasmRuntimeErrorDetails(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
  faultCode: number,
  coreNode: number,
): FunctionalWasmRuntimeErrorDetails {
  const entryName = functionalEntryName(module);
  const node = coreNode >= 0 ? nodes[coreNode] : undefined;
  const nodeContext = node === undefined ? {} : {
    coreNode,
    span: { startByte: node.sourceByteOffset, endByte: node.sourceEndByte },
  };
  const span = nodeContext.span;
  const location = span === undefined ? undefined : locateFunctionalSpan(module.sources, span);
  const context = {
    entryDefinition: module.entryDefinition,
    entryName,
    ...nodeContext,
    ...(location === undefined ? {} : { location }),
  };
  if (faultCode === WASM_FAULT_BLACKHOLE) {
    return {
      ...context,
      code: "F3005",
      kind: "blackhole",
      message: `functional WASM entry ${
        JSON.stringify(entryName)
      } recursively forced an evaluating thunk`,
    };
  }
  if (faultCode === WASM_FAULT_DIVIDE_BY_ZERO) {
    return {
      ...context,
      code: "F3007",
      kind: "divide-by-zero",
      message: `functional WASM entry ${JSON.stringify(entryName)} divided by zero`,
    };
  }
  if (faultCode === WASM_FAULT_OUT_OF_MEMORY) {
    return {
      ...context,
      code: "F3003",
      kind: "out-of-memory",
      message: `functional WASM entry ${JSON.stringify(entryName)} could not grow linear memory`,
    };
  }
  if (faultCode === WASM_FAULT_OUT_OF_FUEL) {
    return {
      ...context,
      code: "F3002",
      kind: "out-of-fuel",
      message: `functional WASM entry ${JSON.stringify(entryName)} exhausted its semantic fuel`,
    };
  }
  if (faultCode === WASM_FAULT_INVALID_NUMERIC_CONVERSION) {
    return {
      ...context,
      code: "F3012",
      kind: "invalid-numeric-conversion",
      message: `functional WASM entry ${
        JSON.stringify(entryName)
      } converted a non-finite or out-of-range float to an integer`,
    };
  }
  if (faultCode === WASM_FAULT_OUT_OF_BOUNDS) {
    return {
      ...context,
      code: "F3103",
      kind: "out-of-bounds",
      message: `functional WASM entry ${
        JSON.stringify(entryName)
      } accessed a buffer outside its bounds`,
    };
  }
  if (faultCode === WASM_FAULT_EXPLICIT) {
    const detail = node === undefined ? undefined : module.symbolNames[node.payload];
    return {
      ...context,
      code: "F3013",
      kind: "explicit-fault",
      message: `functional WASM entry ${JSON.stringify(entryName)} raised an explicit fault${
        detail === undefined ? "" : `: ${detail}`
      }`,
    };
  }
  return {
    ...context,
    code: "F3103",
    kind: "trap",
    message: `functional WASM entry ${
      JSON.stringify(entryName)
    } reported unknown runtime fault ${faultCode}`,
  };
}

export function throwFunctionalWasmTrap(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
  instance: WebAssembly.Instance,
  cause: unknown,
): never {
  if (cause instanceof FunctionalWasmRuntimeError) throw cause;
  const runtimeFault = instance.exports.runtimeFault;
  const runtimeFaultNode = instance.exports.runtimeFaultNode;
  if (
    runtimeFault instanceof WebAssembly.Global &&
    Number(runtimeFault.value) !== 0 &&
    runtimeFaultNode instanceof WebAssembly.Global
  ) {
    throw new FunctionalWasmRuntimeError(
      functionalWasmRuntimeErrorDetails(
        module,
        nodes,
        Number(runtimeFault.value),
        Number(runtimeFaultNode.value),
      ),
      cause,
    );
  }
  if (cause instanceof WebAssembly.RuntimeError) {
    throw new FunctionalWasmRuntimeError({
      code: "F3103",
      kind: "trap",
      entryDefinition: module.entryDefinition,
      entryName: functionalEntryName(module),
      message: `functional WASM entry ${
        JSON.stringify(functionalEntryName(module))
      } trapped: ${cause.message}`,
    }, cause);
  }
  throw cause;
}

function unsupportedWasmEntryType(
  module: GpuFunctionalModule,
  type: FunctionalType,
): TypeError {
  return new TypeError(
    `functional WASM entry d${module.entryDefinition} has unsupported type ${
      describeFunctionalType(type)
    }; ` +
      `expected a first-order result or ${FUNCTIONAL_INIT_TYPE_NAME} -> first-order result`,
  );
}

export function functionalHostScalarType(
  type: FunctionalType,
): FunctionalHostScalarType | undefined {
  if (
    type.kind === "integer" || type.kind === "signed-integer-64" ||
    type.kind === "float-32" || type.kind === "float-64" ||
    type.kind === "boolean" || type.kind === "unit"
  ) return type;
  return undefined;
}

export function functionalWasmImports(
  module: GpuFunctionalModule,
  init: FunctionalWasmInit | undefined,
): {
  readonly imports: Record<string, Record<string, CallableFunction>>;
  bindInstance(instance: WebAssembly.Instance): void;
} {
  const capabilities = module.hostCapabilities;
  let instance: WebAssembly.Instance | undefined;
  const requireInstance = (): WebAssembly.Instance => {
    if (instance === undefined) {
      throw new Error(
        "functional WASM host capability ran before module instantiation completed",
      );
    }
    return instance;
  };
  const bridge = (
    imports: Record<string, Record<string, CallableFunction>>,
  ) => ({
    imports,
    bindInstance(value: WebAssembly.Instance): void {
      if (instance !== undefined) {
        throw new Error("functional WASM host bridge was bound twice");
      }
      instance = value;
    },
  });
  const externalCapabilities = capabilities.map((capability) => ({
    name: capability.name,
    fields: capability.fields.filter((field) => {
      if (field.kind === "value") return field.wasmLiteral === undefined;
      return field.wasmIntrinsic === undefined;
    }),
  })).filter((capability) => capability.fields.length > 0);
  if (externalCapabilities.length === 0) return bridge({});
  if (init === undefined || init === null || typeof init !== "object") {
    throw invalidFunctionalWasmInit(
      "init",
      `functional WASM module requires init capabilities ${
        JSON.stringify(externalCapabilities.map((capability) => capability.name))
      }; received ${describeHostBinding(init)}`,
    );
  }
  const imports = Object.create(null) as Record<
    string,
    Record<string, CallableFunction>
  >;
  for (const capability of externalCapabilities) {
    const fields = Object.hasOwn(init, capability.name) ? init[capability.name] : undefined;
    if (fields === undefined || fields === null || typeof fields !== "object") {
      throw invalidFunctionalWasmInit(
        capability.name,
        `functional WASM init omitted capability ${JSON.stringify(capability.name)}; received ${
          describeHostBinding(fields)
        }`,
      );
    }
    const capabilityImports = Object.create(null) as Record<
      string,
      CallableFunction
    >;
    imports[hostImportModule(capability.name)] = capabilityImports;
    for (const declaration of capability.fields) {
      const binding = Object.hasOwn(fields, declaration.name)
        ? fields[declaration.name]
        : undefined;
      const key = hostFieldKey(capability.name, declaration.name);
      if (declaration.kind === "value") {
        if (typeof binding === "function" || binding === undefined) {
          throw invalidFunctionalWasmInit(
            key,
            `functional WASM init value ${
              JSON.stringify(key)
            } expected ${declaration.type.kind}; received ${describeHostBinding(binding)}`,
          );
        }
        capabilityImports[declaration.name] = () => {
          try {
            return encodeHostValue(
              requireInstance(),
              module,
              declaration.type,
              declaration.representation ?? declaration.type,
              binding,
              key,
            );
          } catch (cause) {
            if (cause instanceof FunctionalWasmBoundaryError) throw cause;
            throw invalidFunctionalWasmInit(
              key,
              cause instanceof Error
                ? cause.message
                : `host value encoding failed: ${String(cause)}`,
              cause,
            );
          }
        };
        continue;
      }
      if (typeof binding !== "function") {
        throw invalidFunctionalWasmInit(
          key,
          `functional WASM init operation ${JSON.stringify(key)} expected a function; received ${
            describeHostBinding(binding)
          }`,
        );
      }
      capabilityImports[declaration.name] = (argument: number | bigint) => {
        const parameterRepresentation = declaration.parameterRepresentation ??
          declaration.parameter;
        const hostArgument = decodeHostValue(
          requireInstance(),
          module,
          declaration.parameter,
          parameterRepresentation,
          argument,
        );
        try {
          const result = binding(hostArgument);
          return encodeHostValue(
            requireInstance(),
            module,
            declaration.result,
            declaration.resultRepresentation ?? declaration.result,
            result,
            key,
          );
        } catch (cause) {
          if (cause instanceof FunctionalWasmSuspension) throw cause;
          if (cause instanceof FunctionalWasmRuntimeError) throw cause;
          throw functionalHostOperationError(
            module,
            capability.name,
            declaration.name,
            cause,
          );
        }
      };
    }
  }
  return bridge(imports);
}

function decodeHostValue(
  instance: WebAssembly.Instance,
  module: GpuFunctionalModule,
  semanticType: FunctionalHostType,
  representation: FunctionalHostType,
  value: number | bigint,
): FunctionalWasmHostValue {
  if (isErasedRepresentation(representation)) {
    const type = concreteFunctionalType(semanticType);
    return {
      kind: "erased",
      type,
      value: decodeFunctionalWasmBoxedValue(instance, module, type, value, 2_047),
    };
  }
  return representation.kind === "tuple" || representation.kind === "named"
    ? decodeFunctionalWasmValue(
      instance,
      module,
      concreteFunctionalType(representation),
      value,
      2_047,
    )
    : hostValueFromNative(value, representation);
}

function encodeHostValue(
  instance: WebAssembly.Instance,
  module: GpuFunctionalModule,
  semanticType: FunctionalHostType,
  representation: FunctionalHostType,
  value: FunctionalWasmHostValue,
  key: string,
): number | bigint {
  if (isErasedRepresentation(representation)) {
    if (value.kind !== "erased") {
      throw new TypeError(
        `functional WASM erased host value ${
          JSON.stringify(key)
        } expected erased; received ${value.kind}`,
      );
    }
    const expected = concreteFunctionalType(semanticType);
    if (
      functionalRuntimeTypeDescriptorKey(value.type) !==
        functionalRuntimeTypeDescriptorKey(expected)
    ) {
      throw new TypeError(
        `functional WASM erased host value ${JSON.stringify(key)} has descriptor ${
          describeFunctionalType(value.type)
        }; expected ${describeFunctionalType(expected)}`,
      );
    }
    return encodeFunctionalWasmValue(instance, module, expected, value.value);
  }
  if (representation.kind === "tuple" || representation.kind === "named") {
    return encodeFunctionalWasmValue(
      instance,
      module,
      concreteFunctionalType(representation),
      value,
    );
  }
  return hostValueAsNumber(value, representation, key);
}

function isErasedRepresentation(type: FunctionalHostType): boolean {
  return type.kind === "named" && type.name === FUNCTIONAL_ERASED_TYPE_NAME &&
    type.arguments.length === 0;
}

function hostValueFromNative(
  value: number | bigint,
  type: FunctionalHostType,
): FunctionalWasmHostValue {
  if (type.kind === "tuple" || type.kind === "named") {
    throw new TypeError(
      "functional WASM aggregate host values require an instantiated module",
    );
  }
  if (type.kind === "integer") {
    return { kind: "integer", value: Number(value) | 0 };
  }
  if (type.kind === "signed-integer-64") {
    return { kind: "signed-integer-64", value: BigInt(value) };
  }
  if (type.kind === "float-32") {
    return { kind: "float-32", value: Number(value) };
  }
  if (type.kind === "float-64") {
    return { kind: "float-64", value: Number(value) };
  }
  if (type.kind === "boolean") {
    return { kind: "boolean", value: value !== 0 && value !== 0n };
  }
  return { kind: "unit" };
}

function hostValueAsNumber(
  value: FunctionalWasmInitBinding,
  expectedType: FunctionalHostType,
  field: string,
): number | bigint {
  if (expectedType.kind === "tuple" || expectedType.kind === "named") {
    throw new TypeError(
      `functional WASM aggregate host field ${
        JSON.stringify(field)
      } requires an instantiated module`,
    );
  }
  if (
    value === null || typeof value !== "object" || typeof value === "function"
  ) {
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
  if (value.kind === "boolean") {
    const payload: unknown = value.value;
    if (typeof payload !== "boolean") {
      throw new TypeError(
        `functional WASM host field ${
          JSON.stringify(field)
        } returned ${typeof payload}; expected a boolean payload`,
      );
    }
    return payload ? 1 : 0;
  }
  if (value.kind === "signed-integer-64") {
    const payload: unknown = value.value;
    if (
      typeof payload !== "bigint" ||
      payload < -0x8000000000000000n || payload > 0x7fffffffffffffffn
    ) {
      throw new RangeError(
        `functional WASM host field ${JSON.stringify(field)} returned ${
          typeof payload === "bigint" ? payload : typeof payload
        }; expected signed i64`,
      );
    }
    return payload;
  }
  if (value.kind === "float-32" || value.kind === "float-64") {
    const valueKind = value.kind;
    const payload: unknown = value.value;
    if (typeof payload !== "number") {
      throw new TypeError(
        `functional WASM host field ${
          JSON.stringify(field)
        } returned ${typeof payload}; expected a ${valueKind} payload`,
      );
    }
    return valueKind === "float-32" ? Math.fround(payload) : payload;
  }
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
  if (typeof binding !== "object") {
    return `${typeof binding} ${JSON.stringify(binding)}`;
  }
  const kind = (binding as { kind?: unknown }).kind;
  return kind === undefined ? "object without a kind" : `object with kind ${JSON.stringify(kind)}`;
}

export function invalidFunctionalWasmInit(
  path: string,
  message: string,
  cause?: unknown,
): FunctionalWasmBoundaryError {
  return new FunctionalWasmBoundaryError({
    code: "F4102",
    kind: "invalid-init",
    path,
    message,
  }, cause);
}

export function functionalHostOperationError(
  module: GpuFunctionalModule,
  capability: string,
  operation: string,
  cause: unknown,
): FunctionalWasmRuntimeError {
  const key = hostFieldKey(capability, operation);
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new FunctionalWasmRuntimeError({
    code: "F3101",
    kind: "host-operation",
    entryDefinition: module.entryDefinition,
    entryName: functionalEntryName(module),
    capability,
    operation,
    message: `functional WASM host operation ${JSON.stringify(key)} failed: ${reason}`,
  }, cause);
}

export function hostFieldKey(capability: string, field: string): string {
  return `${capability}.${field}`;
}

export function hostImportModule(capability: string): string {
  return `${HOST_IMPORT_MODULE_PREFIX}${capability}`;
}
