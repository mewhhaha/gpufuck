import { CoreTag, EvaluationProfile, NO_INDEX } from "./abi.ts";
import {
  type CompiledModule,
  completeTypeDeclarations,
  type CoreNode,
  type WasmExport,
} from "./compiler_module.ts";
import type { WasmCompilationOptions } from "./wasm_contract.ts";
import { compileWasmArtifact } from "./wasm_codegen.ts";
import { compileWasmGc } from "./wasm_gc_codegen.ts";

export interface WasmBatchCompilationOptions extends WasmCompilationOptions {
  readonly exportNames?: readonly string[];
}

export interface WasmBatchArtifact {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly exports: readonly string[];
}

export async function compileModulesToWasm(
  modules: readonly CompiledModule[],
  options: WasmBatchCompilationOptions = {},
): Promise<WasmBatchArtifact> {
  if (!Array.isArray(modules)) {
    throw new TypeError("functional Wasm batch modules must be an array");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("functional Wasm batch options must be an object");
  }
  if (
    options.backend !== undefined &&
    options.backend !== "linear-memory" &&
    options.backend !== "wasm-gc"
  ) {
    throw new TypeError(
      `functional WASM backend must be linear-memory or wasm-gc; received ${
        JSON.stringify(options.backend)
      }`,
    );
  }
  if (
    options.backend === "wasm-gc" &&
    (options.storageCore !== undefined || options.ownedTypeExports !== undefined ||
      options.simd !== undefined)
  ) {
    throw new TypeError(
      "functional WasmGC compilation does not accept linear-memory storage or SIMD options",
    );
  }
  if (modules.length === 0) {
    throw new RangeError("functional Wasm batch compilation requires at least one module");
  }
  const exportNames = normalizedExportNames(modules.length, options.exportNames);
  const bundle = await bundleCompiledModules(modules, exportNames);
  const wasmOptions: WasmCompilationOptions = {
    ...(options.backend === undefined ? {} : { backend: options.backend }),
    ...(options.storageCore === undefined ? {} : { storageCore: options.storageCore }),
    ...(options.ownedTypeExports === undefined
      ? {}
      : { ownedTypeExports: options.ownedTypeExports }),
    ...(options.simd === undefined ? {} : { simd: options.simd }),
  };
  const nodes = await bundle.readCoreNodes();
  const bytes = wasmOptions.backend === "wasm-gc"
    ? compileWasmGc(bundle, nodes)
    : compileWasmArtifact(bundle, nodes, false, wasmOptions).bytes;
  return {
    bytes,
    exports: exportNames,
  };
}

async function bundleCompiledModules(
  modules: readonly CompiledModule[],
  exportNames: readonly string[],
): Promise<CompiledModule> {
  const first = modules[0]!;
  for (const [index, module] of modules.entries()) {
    if (module.evaluationProfile !== first.evaluationProfile) {
      throw new TypeError(
        `functional Wasm batch module ${index} uses evaluation profile ${
          profileName(module.evaluationProfile)
        }; expected ${profileName(first.evaluationProfile)}`,
      );
    }
    if (!sameHostCapabilities(first, module)) {
      throw new TypeError(
        `functional Wasm batch module ${index} declares incompatible host capabilities`,
      );
    }
  }
  const coreNodesByModule = await Promise.all(
    modules.map((module) => module.readCoreNodes()),
  );

  const nodes: CoreNode[] = [];
  const arguments_: CompiledModule["arguments"][number][] = [];
  const caseAlternatives: CompiledModule["caseAlternatives"][number][] = [];
  const constructorNames: string[] = [];
  const constructorArities: number[] = [];
  const definitionNames: string[] = [];
  const typeNames: string[] = [];
  const symbolNames: string[] = [];
  const definitionRoots: number[] = [];
  const declaredDefinitionEffects: CompiledModule["declaredDefinitionEffects"][number][] = [];
  const definitionEffects: CompiledModule["definitionEffects"][number][] = [];
  const typeDeclarations: CompiledModule["typeDeclarations"][number][] = [];
  const hostDefinitions: CompiledModule["hostDefinitions"][number][] = [];
  const wasmExports: WasmExport[] = [];
  const sources: CompiledModule["sources"][number][] = [];
  const typeDeclarationShapes = new Map<string, string>();
  const wasmExportNames = new Set<string>(["main"]);
  let parameterCount = 0;
  let caseBinderCount = 0;
  let typeCount = 0;
  let sourceOffset = 0;

  for (const [moduleIndex, module] of modules.entries()) {
    const exportName = exportNames[moduleIndex]!;
    const nodeOffset = nodes.length;
    const definitionOffset = definitionNames.length;
    const constructorOffset = constructorNames.length;
    const argumentOffset = arguments_.length;
    const alternativeOffset = caseAlternatives.length;
    const parameterOffset = parameterCount;
    const binderOffset = caseBinderCount;
    const symbolOffset = symbolNames.length;
    const typeOffset = typeNames.length;
    const moduleNodes = coreNodesByModule[moduleIndex]!;

    for (const node of moduleNodes) {
      nodes.push(offsetCoreNode(node, {
        nodeOffset,
        definitionOffset,
        constructorOffset,
        argumentOffset,
        alternativeOffset,
        parameterOffset,
        symbolOffset,
        sourceOffset,
        typeOffset,
      }));
    }
    for (const argument of module.arguments) {
      arguments_.push(Object.freeze({ ...argument, node: argument.node + nodeOffset }));
    }
    for (const alternative of module.caseAlternatives) {
      caseAlternatives.push(Object.freeze({
        ...alternative,
        constructor: alternative.constructor + constructorOffset,
        firstBinder: alternative.firstBinder + binderOffset,
        body: alternative.body + nodeOffset,
        sourceByteOffset: alternative.sourceByteOffset + sourceOffset,
        sourceEndByte: alternative.sourceEndByte + sourceOffset,
      }));
    }

    constructorNames.push(...module.constructorNames);
    constructorArities.push(...module.constructorArities);
    definitionNames.push(...module.definitionNames.map((name) => `${exportName}::${name}`));
    typeNames.push(...module.typeNames);
    symbolNames.push(...module.symbolNames.map((name) => `${exportName}::${name}`));
    definitionRoots.push(...module.definitionRoots.map((root) => root + nodeOffset));
    declaredDefinitionEffects.push(...module.declaredDefinitionEffects);
    definitionEffects.push(...module.definitionEffects);
    for (const declaration of completeTypeDeclarations(module)) {
      const shape = JSON.stringify(
        declaration,
        (key, value) => key === "startByte" || key === "endByte" ? undefined : value,
      );
      const existingShape = typeDeclarationShapes.get(declaration.name);
      if (existingShape !== undefined && existingShape !== shape) {
        throw new TypeError(
          `functional Wasm batch module ${moduleIndex} declares nominal type ${
            JSON.stringify(declaration.name)
          } differently from an earlier module`,
        );
      }
      typeDeclarationShapes.set(declaration.name, shape);
      typeDeclarations.push(declaration);
    }
    hostDefinitions.push(...module.hostDefinitions.map((binding) => ({
      ...binding,
      definition: `${exportName}::${binding.definition}`,
    })));
    sources.push(...module.sources.map((source) =>
      Object.freeze({
        ...source,
        module: `${exportName}::${source.module}`,
        startByte: source.startByte + sourceOffset,
        endByte: source.endByte + sourceOffset,
      })
    ));

    if (wasmExportNames.has(exportName)) {
      throw new TypeError(
        `functional Wasm batch repeats export ${JSON.stringify(exportName)}`,
      );
    }
    wasmExportNames.add(exportName);
    wasmExports.push(Object.freeze({
      name: exportName,
      definitionIndex: definitionOffset + module.entryDefinition,
      type: module.entryType,
      effects: module.entryEffects,
    }));
    for (const exported of module.wasmExports) {
      const name = `${exportName}__${exported.name}`;
      if (wasmExportNames.has(name)) {
        throw new TypeError(
          `functional Wasm batch repeats export ${JSON.stringify(name)}`,
        );
      }
      wasmExportNames.add(name);
      wasmExports.push(Object.freeze({
        ...exported,
        name,
        definitionIndex: definitionOffset + exported.definitionIndex,
      }));
    }

    parameterCount += module.parameterCount;
    caseBinderCount += module.caseBinderCount;
    typeCount += module.typeCount;
    sourceOffset += moduleSourceByteLength(module, moduleNodes);
  }

  return Object.freeze({
    nodeCount: nodes.length,
    definitionCount: definitionNames.length,
    constructorCount: constructorNames.length,
    typeCount,
    parameterCount,
    arguments: Object.freeze(arguments_),
    caseAlternatives: Object.freeze(caseAlternatives),
    caseBinderCount,
    constructorNames: Object.freeze(constructorNames),
    constructorArities: Object.freeze(constructorArities),
    definitionNames: Object.freeze(definitionNames),
    typeNames: Object.freeze(typeNames),
    symbolNames: Object.freeze(symbolNames),
    definitionRoots: Object.freeze(definitionRoots),
    entryDefinition: modules[0]!.entryDefinition,
    entryType: modules[0]!.entryType,
    entryEffects: modules[0]!.entryEffects,
    declaredDefinitionEffects: Object.freeze(declaredDefinitionEffects),
    definitionEffects: Object.freeze(definitionEffects),
    typeDeclarations: Object.freeze(typeDeclarations),
    hostCapabilities: modules[0]!.hostCapabilities,
    hostDefinitions: Object.freeze(hostDefinitions),
    wasmExports: Object.freeze(wasmExports),
    sources: Object.freeze(sources),
    evaluationProfile: modules[0]!.evaluationProfile,
    readCoreNodes: () => Promise.resolve(Object.freeze(nodes)),
    destroy: () => {},
  });
}

interface CoreOffsets {
  readonly nodeOffset: number;
  readonly definitionOffset: number;
  readonly constructorOffset: number;
  readonly argumentOffset: number;
  readonly alternativeOffset: number;
  readonly parameterOffset: number;
  readonly symbolOffset: number;
  readonly sourceOffset: number;
  readonly typeOffset: number;
}

function offsetCoreNode(node: CoreNode, offsets: CoreOffsets): CoreNode {
  let payload = node.payload;
  if (node.tag === CoreTag.Global) payload += offsets.definitionOffset;
  if (node.tag === CoreTag.Constructor) payload += offsets.constructorOffset;
  if (node.tag === CoreTag.Lambda) payload += offsets.parameterOffset;
  if (node.tag === CoreTag.Apply && node.child1 > 0) payload += offsets.argumentOffset;
  if (node.tag === CoreTag.Case) payload += offsets.alternativeOffset;
  if (
    node.tag === CoreTag.StoreEmpty || node.tag === CoreTag.StoreNew ||
    node.tag === CoreTag.StoreLength || node.tag === CoreTag.StoreRead ||
    node.tag === CoreTag.StoreWrite || node.tag === CoreTag.StoreGrow
  ) {
    payload += offsets.typeOffset;
  }
  if (
    node.tag === CoreTag.Text || node.tag === CoreTag.Bytes ||
    node.tag === CoreTag.RuntimeFault
  ) {
    payload += offsets.symbolOffset;
  }

  const [child0, child1, child2] = offsetNodeChildren(node, offsets.nodeOffset);
  const typedChild1 = node.tag === CoreTag.Unary && node.child1 !== NO_INDEX
    ? node.child1 + offsets.typeOffset
    : child1;
  const typedChild2 = (
      node.tag === CoreTag.Prim || node.tag === CoreTag.Binary ||
      node.tag === CoreTag.BufferAppend
    ) && node.child2 !== NO_INDEX
    ? node.child2 + offsets.typeOffset
    : child2;
  return Object.freeze({
    ...node,
    payload,
    child0: node.tag === CoreTag.Prim && node.child1 > 0
      ? node.child0 + offsets.argumentOffset
      : child0,
    child1: typedChild1,
    child2: typedChild2,
    sourceByteOffset: node.sourceByteOffset + offsets.sourceOffset,
    sourceEndByte: node.sourceEndByte + offsets.sourceOffset,
  });
}

function offsetNodeChildren(
  node: CoreNode,
  offset: number,
): readonly [number, number, number] {
  const reference = (value: number): number => value === NO_INDEX ? value : value + offset;
  switch (node.tag) {
    case CoreTag.Lambda:
    case CoreTag.Unary:
    case CoreTag.NumericConvert:
    case CoreTag.StoreLength:
    case CoreTag.PatternBind:
      return [reference(node.child0), node.child1, node.child2];
    case CoreTag.Let:
    case CoreTag.LetRec:
    case CoreTag.Binary:
    case CoreTag.BufferAppend:
    case CoreTag.StoreNew:
    case CoreTag.StoreRead:
    case CoreTag.CaseArm:
      return [reference(node.child0), reference(node.child1), node.child2];
    case CoreTag.Apply:
    case CoreTag.Case:
      return [reference(node.child0), node.child1, node.child2];
    case CoreTag.If:
    case CoreTag.StoreWrite:
    case CoreTag.StoreGrow:
      return [reference(node.child0), reference(node.child1), reference(node.child2)];
    default:
      return [node.child0, node.child1, node.child2];
  }
}

function normalizedExportNames(
  moduleCount: number,
  names: readonly string[] | undefined,
): readonly string[] {
  const resolved = names ?? Array.from({ length: moduleCount }, (_, index) => `module${index}`);
  if (resolved.length !== moduleCount) {
    throw new RangeError(
      `functional Wasm batch has ${moduleCount} modules but ${resolved.length} export names`,
    );
  }
  const unique = new Set<string>();
  for (const [index, name] of resolved.entries()) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`functional Wasm batch export ${index} must be a non-empty string`);
    }
    if (name === "main" || unique.has(name)) {
      throw new TypeError(`functional Wasm batch repeats reserved export ${JSON.stringify(name)}`);
    }
    unique.add(name);
  }
  return Object.freeze([...resolved]);
}

function sameHostCapabilities(left: CompiledModule, right: CompiledModule): boolean {
  return JSON.stringify(
    left.hostCapabilities,
    (_, value) => value instanceof Set ? [...value] : value,
  ) === JSON.stringify(right.hostCapabilities, (_, value) =>
    value instanceof Set ? [...value] : value);
}

function moduleSourceByteLength(
  module: CompiledModule,
  nodes: readonly CoreNode[],
): number {
  return Math.max(
    1,
    ...module.sources.map((source) => source.endByte),
    ...nodes.map((node) => node.sourceEndByte),
  );
}

function profileName(profile: EvaluationProfile): string {
  return profile === EvaluationProfile.StrictEager ? "strict-eager" : "lazy-call-by-need";
}
