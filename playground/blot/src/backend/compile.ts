// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Surface -> Wasm, through gpufuck.
//
// This is the one place blot touches a device outside the parser's throughput
// path, and it is deliberately the last stage: `blot check` infers, checks
// ownership, and reports everything it can without a WebGPU adapter existing.

import {
  buildSurfaceModule,
  type CanonicalAbiFunction,
  type CanonicalAbiImport,
  type CanonicalAbiInterface,
  type CanonicalAbiType,
  compileModuleToWasm,
  CpuCompiler,
  EvaluationProfile,
  GpuCompiler,
  GpuEvaluator,
  type HostCapabilityDeclaration,
  requestWebGpuDevice,
  runWasmExport,
  runWasmModule,
  STORE_TYPE_NAME,
  TEXT_TYPE_NAME,
  type Type,
  type TypeSchema,
  type WasmInit,
  type WasmValue,
} from "../../../../functional.ts";
import { BlotError } from "../diagnostic.ts";
import { load } from "../load.ts";
import { checkFile } from "../check/mod.ts";
import type { Imports } from "../comptime/eval.ts";
import { bridge } from "../check/bridge.ts";
import type { SimpleType } from "../check/type.ts";
import { lowerModule, type RuntimeConstructor, type RuntimeTypeDeclaration } from "./lower.ts";
import { type StagedExport, stageModule } from "../stage.ts";

export interface WasmManifest {
  readonly format: "blot-core-wasm";
  readonly abi: {
    readonly major: 1;
    readonly minor: 0;
    readonly memory: "memory32";
    readonly stringEncoding: "utf-8";
    readonly maximumFlatParameters: 16;
    readonly maximumFlatResults: 1;
    readonly memoryExport: "memory";
    readonly reallocExport: "cabi_realloc";
  };
  readonly source: string;
  readonly exports: readonly {
    readonly sourceName: string;
    readonly name: string | null;
    readonly phase: "runtime" | "comptime";
    readonly function: WasmAbiFunction | null;
    readonly postReturn: string | null;
    readonly effects: readonly string[];
    readonly ownership: "owned" | null;
  }[];
  readonly imports: readonly WasmAbiImport[];
}

export interface WasmAbiFunction {
  readonly parameters: readonly WasmAbiType[];
  readonly result: WasmAbiType;
}

export interface WasmAbiImport {
  readonly capability: string;
  readonly operation: string;
  readonly module: string;
  readonly name: string;
  readonly function: WasmAbiFunction;
}

export type WasmAbiType =
  | { readonly kind: "unit" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "text" }
  | { readonly kind: "array"; readonly element: WasmAbiType }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: string;
      readonly type: WasmAbiType;
    }[];
  }
  | {
    readonly kind: "variant";
    readonly cases: readonly {
      readonly name: string;
      readonly payload?: WasmAbiType;
    }[];
  }
  | {
    readonly kind: "sealed";
    readonly name: string;
    readonly inner: WasmAbiType;
  };

interface InternalWasmManifest {
  readonly format: WasmManifest["format"];
  readonly abi: WasmManifest["abi"];
  readonly source: string;
  readonly exports: readonly {
    readonly sourceName: string;
    readonly name: string | null;
    readonly phase: "runtime" | "comptime";
    readonly function: CanonicalAbiFunction | null;
    readonly postReturn: string | null;
    readonly effects: readonly string[];
    readonly ownership: "owned" | null;
  }[];
  readonly imports: readonly CanonicalAbiImport[];
}

export interface Built {
  readonly wasm: Uint8Array;
  readonly manifest: WasmManifest;
  /** Exact bytes stored in the `blot:abi` custom section and sidecar. */
  readonly manifestBytes: Uint8Array;
  /** Host capabilities the module imports, one per host effect. */
  readonly capabilities: readonly string[];
  /** Field names per synthesized nominal, for reading a record back. */
  readonly shapes: ReadonlyMap<string, readonly string[]>;
  /** Source spellings for constructors decoded from the runtime ABI. */
  readonly constructors: ReadonlyMap<string, RuntimeConstructor>;
}

export async function build(path: string): Promise<Built> {
  const compiled = await compile(path);
  try {
    const internalManifest = manifest(
      path,
      compiled.exports,
      compiled.lowered.exports,
      compiled.module.wasmExports,
      compiled.lowered.capabilities,
      compiled.lowered.runtimeTypes,
    );
    const builtManifest = publicManifest(internalManifest);
    const manifestBytes = serializeManifest(builtManifest);
    const coreWasm = await compileModuleToWasm(compiled.module, {
      canonicalAbi: canonicalInterface(internalManifest),
    });
    const wasm = appendCustomSection(coreWasm, "blot:abi", manifestBytes);
    return {
      wasm,
      manifest: builtManifest,
      manifestBytes,
      capabilities: compiled.lowered.capabilities.flatMap((capability) => {
        if (
          capability.fields.some((field) =>
            field.kind === "operation" && field.wasmIntrinsic === undefined
          )
        ) return [capability.name];
        return [];
      }),
      shapes: compiled.lowered.shapes,
      constructors: compiled.lowered.constructors,
    };
  } finally {
    compiled.module.destroy();
    compiled.device.destroy();
  }
}

/**
 * Check the exact surface module sent to gpufuck without initializing WebGPU.
 *
 * This is the backend's CPU oracle: a blot program that passes checking but
 * fails here exposes a lowering bug.
 */
export async function validateLowering(path: string): Promise<WasmManifest> {
  const prepared = await prepare(path);
  const compilation = await new CpuCompiler().compileModule(prepared.module);
  if (!compilation.ok) {
    throw loweringBug(compilation.diagnostics, prepared.loaded.module.span);
  }
  try {
    return publicManifest(manifest(
      path,
      prepared.exports,
      prepared.lowered.exports,
      compilation.module.wasmExports,
      prepared.lowered.capabilities,
      prepared.lowered.runtimeTypes,
    ));
  } finally {
    compilation.module.destroy();
  }
}

/** Compile with gpufuck's CPU oracle and execute the emitted WebAssembly. */
export async function runLowering(
  path: string,
  init: WasmInit = {},
): Promise<unknown> {
  const prepared = await prepare(path);
  const compilation = await new CpuCompiler().compileModule(prepared.module);
  if (!compilation.ok) {
    throw loweringBug(compilation.diagnostics, prepared.loaded.module.span);
  }
  try {
    const execution = await runWasmModule(compilation.module, { init });
    return execution.value;
  } finally {
    compilation.module.destroy();
  }
}

/** Invoke one runtime field from the module result by its blot source name. */
export async function runLoweringExport(
  path: string,
  sourceName: string,
  arguments_: readonly WasmValue[] = [],
  init: WasmInit = {},
): Promise<unknown> {
  const prepared = await prepare(path);
  const exported = prepared.lowered.exports.find((candidate) =>
    candidate.sourceName === sourceName
  );
  if (exported === undefined) {
    throw new BlotError({
      code: "BLOT_NO_RUNTIME_EXPORT",
      message: `Module ${path} has no runtime export \`${sourceName}\`.`,
      span: prepared.loaded.module.span,
    });
  }
  const compilation = await new CpuCompiler().compileModule(prepared.module);
  if (!compilation.ok) {
    throw loweringBug(compilation.diagnostics, prepared.loaded.module.span);
  }
  try {
    const execution = await runWasmExport(
      compilation.module,
      exported.wasmName,
      {
        arguments: arguments_,
        init,
      },
    );
    return execution.value;
  } finally {
    compilation.module.destroy();
  }
}

export interface Verified extends Built {
  readonly value: unknown;
  readonly ran: unknown;
}

export interface VerifyOptions {
  readonly evaluatorInit?: WasmInit;
  readonly wasmInit?: WasmInit;
}

export async function verify(
  path: string,
  options: VerifyOptions = {},
): Promise<Verified> {
  let evaluatorInit: WasmInit = {};
  if (options.evaluatorInit !== undefined) {
    evaluatorInit = options.evaluatorInit;
  }
  let wasmInit: WasmInit = {};
  if (options.wasmInit !== undefined) wasmInit = options.wasmInit;
  const compiled = await compile(path);
  try {
    let value: unknown = null;
    try {
      const evaluator = await GpuEvaluator.create(compiled.device);
      const execution = await evaluator.evaluate(compiled.module, {
        resultForm: "deep",
        wasmInit: evaluatorInit,
      });
      if (execution.ok) {
        value = execution.value;
      } else {
        value = execution.fault;
      }
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) message = error.message;
      value = {
        unavailable: message,
      };
    }
    let ran: unknown = null;
    try {
      const execution = await runWasmModule(compiled.module, {
        init: wasmInit,
      });
      ran = execution.value;
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) message = error.message;
      ran = {
        unavailable: message,
      };
    }
    const internalManifest = manifest(
      path,
      compiled.exports,
      compiled.lowered.exports,
      compiled.module.wasmExports,
      compiled.lowered.capabilities,
      compiled.lowered.runtimeTypes,
    );
    const builtManifest = publicManifest(internalManifest);
    const manifestBytes = serializeManifest(builtManifest);
    const coreWasm = await compileModuleToWasm(compiled.module, {
      canonicalAbi: canonicalInterface(internalManifest),
    });
    const wasm = appendCustomSection(coreWasm, "blot:abi", manifestBytes);
    return {
      wasm,
      value,
      ran,
      manifest: builtManifest,
      manifestBytes,
      capabilities: compiled.lowered.capabilities.flatMap((capability) => {
        if (
          capability.fields.some((field) =>
            field.kind === "operation" && field.wasmIntrinsic === undefined
          )
        ) return [capability.name];
        return [];
      }),
      shapes: compiled.lowered.shapes,
      constructors: compiled.lowered.constructors,
    };
  } finally {
    compiled.module.destroy();
    compiled.device.destroy();
  }
}

async function compile(path: string) {
  const prepared = await prepare(path);
  const device = await requestWebGpuDevice();
  const compiler = await GpuCompiler.create(device);
  const compilation = await compiler.compileModule(prepared.module);
  if (!compilation.ok) {
    device.destroy();
    throw loweringBug(compilation.diagnostics, prepared.loaded.module.span);
  }
  return {
    device,
    module: compilation.module,
    lowered: prepared.lowered,
    exports: prepared.exports,
  };
}

async function prepare(path: string) {
  const loaded = await load(path);
  // Checking first is not politeness: lowering consumes the field and
  // constructor sets inference recorded, and cannot proceed without them.
  const checked = await checkFile(path);
  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }
  const moduleImports = loaded.closure.imports;
  let imports: Imports = new Map();
  if (moduleImports !== undefined) imports = moduleImports;
  const staged = stageModule(
    loaded.module,
    checked.values,
    imports,
    checked.shapes,
  );
  const runtimeExports = staged.exports.flatMap((exported) => {
    if (exported.phase !== "runtime") return [];
    let type = exportType(checked.moduleType, exported.sourceName);
    if (
      exported.value !== undefined &&
      exported.value.tag !== "tag" &&
      (hasUnconstrainedType(type, new Set()) ||
        exported.value.tag === "shape")
    ) {
      const evaluated = bridge(exported.value);
      if (evaluated !== null) type = evaluated;
    }
    return [{
      sourceName: exported.sourceName,
      type,
      value: exported.value,
    }];
  });
  const lowered = lowerModule(
    staged.module,
    {
      ...checked,
      shapes: new Map([...checked.shapes, ...staged.shapes]),
    },
    checked.values,
    runtimeExports,
  );

  const module = buildSurfaceModule(
    lowered.definitions,
    lowered.types,
    lowered.entry,
    loaded.source.length,
    {
      evaluationProfile: EvaluationProfile.StrictEager,
      hostCapabilities: lowered.capabilities,
      hostDefinitions: lowered.hostDefinitions,
      wasmExports: lowered.exports.map((exported) => ({
        name: exported.wasmName,
        definition: exported.definition,
      })),
    },
  );
  return {
    loaded,
    module,
    lowered,
    exports: staged.exports,
  };
}

function exportType(type: SimpleType, sourceName: string): SimpleType {
  if (sourceName === "default") return type;
  const fields = recordFields(type, new Set());
  if (fields === null) {
    throw new Error(
      `checked module result omitted record type for export ${sourceName}`,
    );
  }
  const field = fields.get(sourceName);
  if (field === undefined) {
    throw new Error(
      `checked module result omitted export field ${sourceName}`,
    );
  }
  return field;
}

function recordFields(
  type: SimpleType,
  seen: Set<number>,
): ReadonlyMap<string, SimpleType> | null {
  if (type.tag === "record") return type.fields;
  if (type.tag !== "var" || seen.has(type.id)) return null;
  seen.add(type.id);
  for (const bound of [...type.lower, ...type.upper]) {
    const fields = recordFields(bound, seen);
    if (fields !== null) return fields;
  }
  return null;
}

function hasUnconstrainedType(
  type: SimpleType,
  seen: Set<number>,
): boolean {
  switch (type.tag) {
    case "var":
      if (seen.has(type.id)) return false;
      seen.add(type.id);
      if (type.lower.length === 0 && type.upper.length === 0) return true;
      return [...type.lower, ...type.upper].some((bound) => hasUnconstrainedType(bound, seen));
    case "forall":
      return hasUnconstrainedType(type.body, seen);
    case "fun":
      return hasUnconstrainedType(type.param, seen) ||
        hasUnconstrainedType(type.result, seen);
    case "record":
      return [...type.fields.values()].some((field) => hasUnconstrainedType(field, seen));
    case "variant":
      return [...type.cases.values()].some((payload) => hasUnconstrainedType(payload, seen));
    case "array":
      return hasUnconstrainedType(type.element, seen);
    case "union":
      return type.members.some((member) => hasUnconstrainedType(member, seen));
    default:
      return false;
  }
}

function loweringBug(
  diagnostics: readonly [
    { readonly code: string; readonly message: string },
    ...{
      readonly code: string;
      readonly message: string;
    }[],
  ],
  span: { readonly start: number; readonly end: number },
): BlotError {
  const [first] = diagnostics;
  return new BlotError({
    code: "BLOT_LOWERING_BUG",
    message:
      `gpufuck rejected the lowered module: ${first.code}: ${first.message}. blot accepted this program, so the lowering is wrong.`,
    span,
  });
}

function manifest(
  source: string,
  exports: readonly StagedExport[],
  lowered: readonly {
    readonly sourceName: string;
    readonly wasmName: string;
    readonly type: TypeSchema;
  }[],
  compiledExports: readonly {
    readonly name: string;
    readonly type: Type;
    readonly effects: ReadonlySet<string>;
  }[],
  capabilities: readonly HostCapabilityDeclaration[],
  runtimeTypes: ReadonlyMap<string, RuntimeTypeDeclaration>,
): InternalWasmManifest {
  const imports = capabilities.flatMap((capability) =>
    capability.fields.flatMap((field) => {
      if (field.kind !== "operation") return [];
      if (field.wasmIntrinsic !== undefined) return [];
      return [{
        capability: capability.name,
        operation: field.name,
        module: `blot:host/${capability.name}`,
        name: field.name,
        function: {
          parameters: [canonicalType(field.parameter, runtimeTypes)],
          result: canonicalType(field.result, runtimeTypes),
        },
      }];
    })
  );
  return {
    format: "blot-core-wasm",
    abi: {
      major: 1,
      minor: 0,
      memory: "memory32",
      stringEncoding: "utf-8",
      maximumFlatParameters: 16,
      maximumFlatResults: 1,
      memoryExport: "memory",
      reallocExport: "cabi_realloc",
    },
    source,
    exports: exports.map((exported) => {
      let name: string | null = null;
      if (exported.phase === "runtime") {
        const runtime = lowered.find((candidate) => candidate.sourceName === exported.sourceName);
        if (runtime === undefined) {
          throw new Error(
            `lowering omitted runtime export ${exported.sourceName}`,
          );
        }
        name = runtime.wasmName;
      }
      let function_: CanonicalAbiFunction | null = null;
      let postReturn: string | null = null;
      let effects: readonly string[] = [];
      let ownership: "owned" | null = null;
      if (name !== null) {
        const compiled = compiledExports.find((candidate) => candidate.name === name);
        if (compiled === undefined) {
          throw new Error(`gpufuck omitted compiled export ${name}`);
        }
        const runtime = lowered.find((candidate) => candidate.wasmName === name);
        if (runtime === undefined) {
          throw new Error(`lowering omitted runtime schema ${name}`);
        }
        function_ = canonicalFunction(runtime.type, runtimeTypes);
        if (canonicalResultIsIndirect(function_.result)) {
          postReturn = `cabi_post_${name}`;
        }
        effects = [...compiled.effects].sort();
        ownership = "owned";
      }
      return {
        sourceName: exported.sourceName,
        name,
        phase: exported.phase,
        function: function_,
        postReturn,
        effects,
        ownership,
      };
    }),
    imports,
  };
}

function canonicalInterface(
  manifest: InternalWasmManifest,
): CanonicalAbiInterface {
  return {
    version: 1,
    exports: manifest.exports.flatMap((exported) => {
      if (exported.name === null || exported.function === null) return [];
      if (exported.postReturn === null) {
        return [{
          name: exported.name,
          function: exported.function,
        }];
      }
      return [{
        name: exported.name,
        function: exported.function,
        postReturn: exported.postReturn,
      }];
    }),
    imports: manifest.imports,
  };
}

function publicManifest(internal: InternalWasmManifest): WasmManifest {
  return {
    format: internal.format,
    abi: internal.abi,
    source: internal.source,
    exports: internal.exports.map((exported) => {
      let function_: WasmAbiFunction | null = null;
      if (exported.function !== null) {
        function_ = publicFunction(exported.function);
      }
      return {
        sourceName: exported.sourceName,
        name: exported.name,
        phase: exported.phase,
        function: function_,
        postReturn: exported.postReturn,
        effects: exported.effects,
        ownership: exported.ownership,
      };
    }),
    imports: internal.imports.map((imported) => ({
      capability: imported.capability,
      operation: imported.operation,
      module: imported.module,
      name: imported.name,
      function: publicFunction(imported.function),
    })),
  };
}

function publicFunction(function_: CanonicalAbiFunction): WasmAbiFunction {
  return {
    parameters: function_.parameters.map(publicType),
    result: publicType(function_.result),
  };
}

function publicType(type: CanonicalAbiType): WasmAbiType {
  if (
    type.kind === "unit" ||
    type.kind === "signed-integer-64" ||
    type.kind === "boolean" ||
    type.kind === "text"
  ) return { kind: type.kind };
  if (type.kind === "array") {
    return { kind: "array", element: publicType(type.element) };
  }
  if (type.kind === "sealed") {
    return {
      kind: "sealed",
      name: type.name,
      inner: publicType(type.inner),
    };
  }
  if (type.kind === "record") {
    return {
      kind: "record",
      fields: type.fields.map((field) => ({
        name: field.name,
        type: publicType(field.type),
      })),
    };
  }
  return {
    kind: "variant",
    cases: type.cases.map((case_) => {
      if (case_.payload === undefined) return { name: case_.name };
      return {
        name: case_.name,
        payload: publicType(case_.payload),
      };
    }),
  };
}

function canonicalFunction(
  schema: TypeSchema,
  runtimeTypes: ReadonlyMap<string, RuntimeTypeDeclaration>,
): CanonicalAbiFunction {
  const parameters: CanonicalAbiType[] = [];
  let result = schema;
  while (result.kind === "function") {
    parameters.push(canonicalType(result.parameter, runtimeTypes));
    result = result.result;
  }
  return {
    parameters,
    result: canonicalType(result, runtimeTypes),
  };
}

function canonicalType(
  schema: TypeSchema,
  runtimeTypes: ReadonlyMap<string, RuntimeTypeDeclaration>,
): CanonicalAbiType {
  if (schema.kind === "unit") return { kind: "unit" };
  if (schema.kind === "signed-integer-64") {
    return { kind: "signed-integer-64" };
  }
  if (schema.kind === "boolean") return { kind: "boolean" };
  if (schema.kind !== "named") {
    throw new Error(
      `Blot ABI cannot publish gpufuck ${schema.kind} as a stable type`,
    );
  }
  if (schema.name === TEXT_TYPE_NAME) return { kind: "text" };
  if (schema.name === STORE_TYPE_NAME) {
    const element = schema.arguments[0];
    if (element === undefined || schema.arguments.length !== 1) {
      throw new Error("Blot ABI Store schema must have exactly one element");
    }
    return {
      kind: "array",
      element: canonicalType(element, runtimeTypes),
    };
  }
  const declaration = runtimeTypes.get(schema.name);
  if (declaration === undefined) {
    throw new Error(
      `Blot ABI omitted runtime declaration ${schema.name}`,
    );
  }
  if (declaration.kind === "record") {
    if (schema.arguments.length !== declaration.fields.length) {
      throw new Error(
        `Blot ABI record ${schema.name} has ${schema.arguments.length} arguments for ${declaration.fields.length} fields`,
      );
    }
    const fields = declaration.fields.map((name, index) => {
      const field = schema.arguments[index];
      if (field === undefined) {
        throw new Error(`Blot ABI record ${schema.name} omitted field ${name}`);
      }
      return {
        name,
        type: canonicalType(field, runtimeTypes),
        coreIndex: index,
      };
    });
    fields.sort((left, right) => {
      if (left.name < right.name) return -1;
      if (left.name > right.name) return 1;
      return 0;
    });
    return {
      kind: "record",
      constructor: schema.name,
      fields,
    };
  }
  if (declaration.kind === "sealed") {
    const inner = schema.arguments[0];
    if (inner === undefined || schema.arguments.length !== 1) {
      throw new Error(
        `Blot ABI seal ${schema.name} must have exactly one carrier`,
      );
    }
    return {
      kind: "sealed",
      name: declaration.sourceName,
      constructor: declaration.runtimeName,
      inner: canonicalType(inner, runtimeTypes),
    };
  }
  const payloads = new Map<string, TypeSchema>();
  let argument = 0;
  for (const case_ of declaration.cases) {
    if (!case_.payload) continue;
    const payload = schema.arguments[argument];
    if (payload === undefined) {
      throw new Error(
        `Blot ABI variant ${schema.name} omitted payload for ${case_.sourceName}`,
      );
    }
    payloads.set(case_.sourceName, payload);
    argument += 1;
  }
  if (argument !== schema.arguments.length) {
    throw new Error(
      `Blot ABI variant ${schema.name} has ${
        schema.arguments.length - argument
      } unused type arguments`,
    );
  }
  const cases = declaration.cases.map((case_) => {
    const payload = payloads.get(case_.sourceName);
    if (payload === undefined) {
      return {
        name: case_.sourceName,
        constructor: case_.runtimeName,
      };
    }
    return {
      name: case_.sourceName,
      constructor: case_.runtimeName,
      payload: canonicalType(payload, runtimeTypes),
    };
  });
  cases.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  return { kind: "variant", cases };
}

function canonicalResultIsIndirect(type: CanonicalAbiType): boolean {
  return flattenCanonicalType(type).length > 1;
}

function flattenCanonicalType(
  type: CanonicalAbiType,
): readonly ("i32" | "i64")[] {
  if (type.kind === "unit") return [];
  if (type.kind === "signed-integer-64") return ["i64"];
  if (type.kind === "boolean") return ["i32"];
  if (type.kind === "text" || type.kind === "array") return ["i32", "i32"];
  if (type.kind === "sealed") return flattenCanonicalType(type.inner);
  if (type.kind === "record") {
    return type.fields.flatMap((field) => flattenCanonicalType(field.type));
  }
  let payload: ("i32" | "i64")[] = [];
  for (const case_ of type.cases) {
    let flattened: readonly ("i32" | "i64")[] = [];
    if (case_.payload !== undefined) {
      flattened = flattenCanonicalType(case_.payload);
    }
    const joined: ("i32" | "i64")[] = [];
    const length = Math.max(payload.length, flattened.length);
    for (let index = 0; index < length; index += 1) {
      const left = payload[index];
      const right = flattened[index];
      if (left === "i64" || right === "i64") joined.push("i64");
      else joined.push("i32");
    }
    payload = joined;
  }
  return ["i32", ...payload];
}

function serializeManifest(manifest: WasmManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

function appendCustomSection(
  wasm: Uint8Array,
  name: string,
  contents: Uint8Array,
): Uint8Array {
  const encodedName = new TextEncoder().encode(name);
  const payload = new Uint8Array([
    ...unsignedLeb128(encodedName.byteLength),
    ...encodedName,
    ...contents,
  ]);
  return new Uint8Array([
    ...wasm,
    0,
    ...unsignedLeb128(payload.byteLength),
    ...payload,
  ]);
}

function unsignedLeb128(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}
