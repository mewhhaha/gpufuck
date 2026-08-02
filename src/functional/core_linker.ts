import { CoreTag, NO_INDEX, type Type } from "./abi.ts";
import { analyzeModuleEffects } from "./effect_analysis.ts";
import { effectSet } from "./effect_set.ts";
import type { HostCapabilityDeclaration, HostDefinitionBinding } from "./host_contract.ts";
import {
  type CompiledModule,
  completeTypeDeclarations,
  type CoreNode,
  registerCompleteTypeDeclarations,
  type WasmExport,
} from "./compiler_module.ts";
import { registerPreparedWasmLambdaAnalysis } from "./prepared_wasm_lambda_analysis.ts";

export interface RelocatableCoreUnit {
  readonly name: string;
  readonly module: CompiledModule;
  readonly sourceByteLength: number;
}

export interface RelocatableCoreEntry {
  readonly definition: string;
  readonly type: Type;
}

/** Links separately compiled modules without introducing a runtime module boundary. */
export async function linkRelocatableCore(
  units: readonly RelocatableCoreUnit[],
  entry: RelocatableCoreEntry,
): Promise<CompiledModule> {
  if (units.length === 0) {
    throw new RangeError("functional Core linker requires at least one compiled module");
  }
  const unitNames = new Set<string>();
  for (const unit of units) {
    if (unitNames.has(unit.name)) {
      throw new TypeError(`functional Core linker repeats module ${JSON.stringify(unit.name)}`);
    }
    unitNames.add(unit.name);
  }

  const nodesByUnit = await Promise.all(units.map((unit) => unit.module.readCoreNodes()));
  const types = canonicalTypes(units);
  const constructors = canonicalConstructors(units);
  const definitions = canonicalDefinitions(units);
  const hostCapabilities = mergedHostCapabilities(units);

  const nodes: CoreNode[] = [];
  const arguments_: CompiledModule["arguments"][number][] = [];
  const caseAlternatives: CompiledModule["caseAlternatives"][number][] = [];
  const symbolNames: string[] = [];
  const definitionRoots = new Array<number>(definitions.names.length);
  const declaredDefinitionEffects = new Array<CompiledModule["declaredDefinitionEffects"][number]>(
    definitions.names.length,
  );
  const hostDefinitions: HostDefinitionBinding[] = [];
  const wasmExports: WasmExport[] = [];
  const wasmExportNames = new Set<string>();
  const sources: CompiledModule["sources"][number][] = [];
  let parameterCount = 0;
  let caseBinderCount = 0;
  let sourceOffset = 0;

  for (const [unitIndex, unit] of units.entries()) {
    const module = unit.module;
    const unitNodes = nodesByUnit[unitIndex]!;
    const nodeOffset = nodes.length;
    const argumentOffset = arguments_.length;
    const alternativeOffset = caseAlternatives.length;
    const symbolOffset = symbolNames.length;
    const definitionMap = definitions.localIndices[unitIndex]!;
    const constructorMap = constructors.localIndices[unitIndex]!;
    const typeMap = types.localIndices[unitIndex]!;

    for (const node of unitNodes) {
      nodes.push(relocateCoreNode(node, {
        nodeOffset,
        argumentOffset,
        alternativeOffset,
        parameterOffset: parameterCount,
        symbolOffset,
        sourceOffset,
        definitionMap,
        constructorMap,
        typeMap,
      }));
    }
    for (const argument of module.arguments) {
      arguments_.push(Object.freeze({ ...argument, node: argument.node + nodeOffset }));
    }
    for (const alternative of module.caseAlternatives) {
      const constructor = constructorMap[alternative.constructor];
      if (constructor === undefined) {
        throw new Error(
          `functional Core linker module ${
            JSON.stringify(unit.name)
          } case references missing constructor ${alternative.constructor}`,
        );
      }
      caseAlternatives.push(Object.freeze({
        ...alternative,
        constructor,
        firstBinder: alternative.firstBinder + caseBinderCount,
        body: alternative.body + nodeOffset,
        sourceByteOffset: alternative.sourceByteOffset + sourceOffset,
        sourceEndByte: alternative.sourceEndByte + sourceOffset,
      }));
    }

    const ownerPrefix = `${unit.name}::`;
    for (const [localIndex, name] of module.definitionNames.entries()) {
      if (!name.startsWith(ownerPrefix)) continue;
      const definitionIndex = definitionMap[localIndex];
      const root = module.definitionRoots[localIndex];
      const declaredEffects = module.declaredDefinitionEffects[localIndex];
      if (definitionIndex === undefined || root === undefined || declaredEffects === undefined) {
        throw new Error(
          `functional Core linker module ${JSON.stringify(unit.name)} omitted owned definition ${
            JSON.stringify(name)
          }`,
        );
      }
      definitionRoots[definitionIndex] = root + nodeOffset;
      declaredDefinitionEffects[definitionIndex] = declaredEffects;
    }

    for (const binding of module.hostDefinitions) {
      const localDefinition = module.definitionNames.indexOf(binding.definition);
      if (localDefinition < 0 || !binding.definition.startsWith(ownerPrefix)) continue;
      const definitionIndex = definitionMap[localDefinition];
      if (definitionIndex === undefined) {
        throw new Error(
          `functional Core linker host binding references missing definition ${
            JSON.stringify(binding.definition)
          }`,
        );
      }
      hostDefinitions.push(Object.freeze({
        ...binding,
        definition: definitions.names[definitionIndex]!,
      }));
    }
    for (const exported of module.wasmExports) {
      const definitionName = module.definitionNames[exported.definitionIndex];
      if (definitionName === undefined || !definitionName.startsWith(ownerPrefix)) continue;
      if (wasmExportNames.has(exported.name)) {
        throw new TypeError(
          `functional Core linker repeats WASM export ${JSON.stringify(exported.name)}`,
        );
      }
      const definitionIndex = definitionMap[exported.definitionIndex];
      if (definitionIndex === undefined) {
        throw new Error(
          `functional Core linker WASM export ${
            JSON.stringify(exported.name)
          } references missing definition`,
        );
      }
      wasmExportNames.add(exported.name);
      wasmExports.push(Object.freeze({ ...exported, definitionIndex }));
    }

    symbolNames.push(...module.symbolNames);
    sources.push(Object.freeze({
      module: unit.name,
      startByte: sourceOffset,
      endByte: sourceOffset + unit.sourceByteLength,
    }));
    parameterCount += module.parameterCount;
    caseBinderCount += module.caseBinderCount;
    sourceOffset += unit.sourceByteLength;
  }

  for (const [definitionIndex, name] of definitions.names.entries()) {
    if (definitionRoots[definitionIndex] === undefined) {
      throw new Error(
        `functional Core linker found no owning body for definition ${JSON.stringify(name)}`,
      );
    }
    if (declaredDefinitionEffects[definitionIndex] === undefined) {
      throw new Error(
        `functional Core linker found no effect declaration for definition ${JSON.stringify(name)}`,
      );
    }
  }

  const entryDefinition = definitions.names.indexOf(entry.definition);
  if (entryDefinition < 0) {
    throw new Error(
      `functional Core linker entry references missing definition ${
        JSON.stringify(entry.definition)
      }`,
    );
  }
  const frozenNodes = Object.freeze(nodes);
  const preliminary: CompiledModule = Object.freeze({
    nodeCount: frozenNodes.length,
    definitionCount: definitions.names.length,
    constructorCount: constructors.names.length,
    typeCount: types.names.length,
    parameterCount,
    arguments: Object.freeze(arguments_),
    caseAlternatives: Object.freeze(caseAlternatives),
    caseBinderCount,
    constructorNames: constructors.names,
    constructorArities: constructors.arities,
    definitionNames: definitions.names,
    typeNames: types.names,
    symbolNames: Object.freeze(symbolNames),
    definitionRoots: Object.freeze(definitionRoots),
    entryDefinition,
    entryType: entry.type,
    entryEffects: effectSet(),
    declaredDefinitionEffects: Object.freeze(declaredDefinitionEffects),
    definitionEffects: Object.freeze(
      Array.from({ length: definitions.names.length }, () => effectSet()),
    ),
    typeDeclarations: types.declarations,
    hostCapabilities,
    hostDefinitions: Object.freeze(hostDefinitions),
    wasmExports: Object.freeze(wasmExports),
    sources: Object.freeze(sources),
    readCoreNodes: () => Promise.resolve(frozenNodes),
    destroy: () => {},
  });
  const effects = analyzeModuleEffects(preliminary, frozenNodes);
  const linked: CompiledModule = Object.freeze({
    ...preliminary,
    entryEffects: effects.entryEffects,
    definitionEffects: effects.definitionEffects,
    wasmExports: Object.freeze(preliminary.wasmExports.map((exported) =>
      Object.freeze({
        ...exported,
        effects: effects.definitionEffects[exported.definitionIndex]!,
      })
    )),
  });
  registerCompleteTypeDeclarations(linked, types.declarations);
  if (effects.wasmLambdaAnalysis !== undefined) {
    registerPreparedWasmLambdaAnalysis(linked, effects.wasmLambdaAnalysis);
  }
  return linked;
}

interface CanonicalIndex {
  readonly names: readonly string[];
  readonly localIndices: readonly (readonly number[])[];
}

interface CanonicalTypes extends CanonicalIndex {
  readonly declarations: CompiledModule["typeDeclarations"];
}

function canonicalTypes(units: readonly RelocatableCoreUnit[]): CanonicalTypes {
  const names: string[] = [];
  const declarations: CompiledModule["typeDeclarations"][number][] = [];
  const indices = new Map<string, number>();
  const shapes = new Map<string, string>();
  const localIndices = units.map((unit, unitIndex) => {
    const complete = completeTypeDeclarations(unit.module);
    if (complete.length !== unit.module.typeCount) {
      throw new Error(
        `functional Core linker module ${
          JSON.stringify(unit.name)
        } has ${complete.length} declarations for ${unit.module.typeCount} types`,
      );
    }
    return unit.module.typeNames.map((name, localIndex) => {
      const declaration = complete[localIndex];
      if (declaration === undefined || declaration.name !== name) {
        throw new Error(
          `functional Core linker module ${
            JSON.stringify(unit.name)
          } type ${localIndex} does not match ${JSON.stringify(name)}`,
        );
      }
      const shape = JSON.stringify(declaration);
      const existing = indices.get(name);
      if (existing !== undefined) {
        if (shapes.get(name) !== shape) {
          throw new TypeError(
            `functional Core linker module ${unitIndex} declares nominal type ${
              JSON.stringify(name)
            } incompatibly`,
          );
        }
        return existing;
      }
      const index = names.length;
      indices.set(name, index);
      shapes.set(name, shape);
      names.push(name);
      declarations.push(declaration);
      return index;
    });
  });
  return {
    names: Object.freeze(names),
    declarations: Object.freeze(declarations),
    localIndices: Object.freeze(localIndices.map((indices) => Object.freeze(indices))),
  };
}

interface CanonicalConstructors extends CanonicalIndex {
  readonly arities: readonly number[];
}

function canonicalConstructors(
  units: readonly RelocatableCoreUnit[],
): CanonicalConstructors {
  const names: string[] = [];
  const arities: number[] = [];
  const indices = new Map<string, number>();
  const localIndices = units.map((unit) =>
    unit.module.constructorNames.map((name, localIndex) => {
      const arity = unit.module.constructorArities[localIndex];
      if (arity === undefined) {
        throw new Error(
          `functional Core linker module ${
            JSON.stringify(unit.name)
          } omitted constructor arity ${localIndex}`,
        );
      }
      const existing = indices.get(name);
      if (existing !== undefined) {
        if (arities[existing] !== arity) {
          throw new TypeError(
            `functional Core linker declares constructor ${
              JSON.stringify(name)
            } with incompatible arities`,
          );
        }
        return existing;
      }
      const index = names.length;
      indices.set(name, index);
      names.push(name);
      arities.push(arity);
      return index;
    })
  );
  return {
    names: Object.freeze(names),
    arities: Object.freeze(arities),
    localIndices: Object.freeze(localIndices.map((indices) => Object.freeze(indices))),
  };
}

function canonicalDefinitions(
  units: readonly RelocatableCoreUnit[],
): CanonicalIndex {
  const names: string[] = [];
  const indices = new Map<string, number>();
  for (const unit of units) {
    const ownerPrefix = `${unit.name}::`;
    for (const name of unit.module.definitionNames) {
      if (!name.startsWith(ownerPrefix)) continue;
      if (indices.has(name)) {
        throw new TypeError(
          `functional Core linker has multiple owners for definition ${JSON.stringify(name)}`,
        );
      }
      indices.set(name, names.length);
      names.push(name);
    }
  }
  const localIndices = units.map((unit) =>
    unit.module.definitionNames.map((name) => {
      const index = indices.get(name);
      if (index === undefined) {
        throw new Error(
          `functional Core linker module ${JSON.stringify(unit.name)} references definition ${
            JSON.stringify(name)
          } with no owner`,
        );
      }
      return index;
    })
  );
  return {
    names: Object.freeze(names),
    localIndices: Object.freeze(localIndices.map((local) => Object.freeze(local))),
  };
}

function mergedHostCapabilities(
  units: readonly RelocatableCoreUnit[],
): readonly HostCapabilityDeclaration[] {
  const capabilities = new Map<string, Map<string, HostCapabilityDeclaration["fields"][number]>>();
  for (const unit of units) {
    for (const capability of unit.module.hostCapabilities) {
      const fields = capabilities.get(capability.name) ?? new Map();
      capabilities.set(capability.name, fields);
      for (const field of capability.fields) {
        const previous = fields.get(field.name);
        if (previous === undefined) {
          fields.set(field.name, field);
          continue;
        }
        const normalize = (_key: string, value: unknown): unknown =>
          value instanceof Set ? [...value] : value;
        if (JSON.stringify(previous, normalize) !== JSON.stringify(field, normalize)) {
          throw new TypeError(
            `functional Core linker declares host field ${
              JSON.stringify(`${capability.name}.${field.name}`)
            } incompatibly`,
          );
        }
      }
    }
  }
  return Object.freeze([...capabilities].map(([name, fields]) =>
    Object.freeze({
      name,
      fields: Object.freeze([...fields.values()]),
    })
  ));
}

interface CoreRelocation {
  readonly nodeOffset: number;
  readonly argumentOffset: number;
  readonly alternativeOffset: number;
  readonly parameterOffset: number;
  readonly symbolOffset: number;
  readonly sourceOffset: number;
  readonly definitionMap: readonly number[];
  readonly constructorMap: readonly number[];
  readonly typeMap: readonly number[];
}

function relocateCoreNode(node: CoreNode, relocation: CoreRelocation): CoreNode {
  let payload = node.payload;
  if (node.tag === CoreTag.Global) {
    payload = requiredIndex(relocation.definitionMap, payload, "definition");
  }
  if (node.tag === CoreTag.Constructor) {
    payload = requiredIndex(relocation.constructorMap, payload, "constructor");
  }
  if (node.tag === CoreTag.Lambda) payload += relocation.parameterOffset;
  if (node.tag === CoreTag.Apply && node.child1 > 0) payload += relocation.argumentOffset;
  if (node.tag === CoreTag.Case) payload += relocation.alternativeOffset;
  if (
    node.tag === CoreTag.StoreEmpty || node.tag === CoreTag.StoreNew ||
    node.tag === CoreTag.StoreLength || node.tag === CoreTag.StoreRead ||
    node.tag === CoreTag.StoreWrite || node.tag === CoreTag.StoreGrow
  ) {
    payload = requiredIndex(relocation.typeMap, payload, "type");
  }
  if (
    node.tag === CoreTag.Text || node.tag === CoreTag.Bytes || node.tag === CoreTag.RuntimeFault
  ) {
    payload += relocation.symbolOffset;
  }

  const [child0, child1, child2] = relocateNodeChildren(node, relocation.nodeOffset);
  const typedChild1 = node.tag === CoreTag.Unary && node.child1 !== NO_INDEX
    ? requiredIndex(relocation.typeMap, node.child1, "type")
    : child1;
  const typedChild2 = (
      node.tag === CoreTag.Prim || node.tag === CoreTag.Binary ||
      node.tag === CoreTag.BufferAppend
    ) && node.child2 !== NO_INDEX
    ? requiredIndex(relocation.typeMap, node.child2, "type")
    : child2;
  return Object.freeze({
    ...node,
    payload,
    child0: node.tag === CoreTag.Prim && node.child1 > 0
      ? node.child0 + relocation.argumentOffset
      : child0,
    child1: typedChild1,
    child2: typedChild2,
    sourceByteOffset: node.sourceByteOffset + relocation.sourceOffset,
    sourceEndByte: node.sourceEndByte + relocation.sourceOffset,
  });
}

function relocateNodeChildren(
  node: CoreNode,
  nodeOffset: number,
): readonly [number, number, number] {
  const reference = (value: number): number => value === NO_INDEX ? value : value + nodeOffset;
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

function requiredIndex(indices: readonly number[], localIndex: number, kind: string): number {
  const index = indices[localIndex];
  if (index === undefined) {
    throw new Error(`functional Core linker references missing ${kind} ${localIndex}`);
  }
  return index;
}
