import {
  AlgebraicTypeWord,
  CASE_ALTERNATIVE_WORD_LENGTH,
  CaseAlternativeWord,
  CONSTRUCTOR_WORD_LENGTH,
  ConstructorWord,
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type EncodedModule,
  NODE_WORD_LENGTH,
  NodeWord,
  TYPE_WORD_LENGTH,
} from "./abi.ts";
import { effectNames } from "./effect_set.ts";
import { type CompiledModule, completeTypeDeclarations, type CoreNode } from "./compiler_module.ts";

const fingerprints = new WeakMap<EncodedModule, string>();
const resolvedCoreFingerprints = new WeakMap<CompiledModule, string>();

export function semanticModuleFingerprint(module: EncodedModule): string {
  const cached = fingerprints.get(module);
  if (cached !== undefined) return cached;

  const hash = new StructuralHash();
  hash.number(module.abiVersion);
  hash.string(module.evaluationProfile);
  hash.string(module.typecheckingProfile);
  hash.strings(module.primitiveCapabilities);
  hash.value(module.hostCapabilities ?? []);
  hash.value(module.hostDefinitions ?? []);
  hash.value(module.declaredDefinitionEffects.map(effectNames));
  hash.value(module.wasmExports ?? []);
  hash.words(module.nodeWords, NODE_WORD_LENGTH, [
    NodeWord.StartByte,
    NodeWord.EndByte,
  ]);
  hash.words(module.parameterWords);
  hash.words(module.argumentWords);
  hash.words(module.caseAlternativeWords, CASE_ALTERNATIVE_WORD_LENGTH, [
    CaseAlternativeWord.StartByte,
    CaseAlternativeWord.EndByte,
  ]);
  hash.words(module.caseBinderWords);
  hash.words(module.definitionWords, DEFINITION_WORD_LENGTH, [
    DefinitionWord.StartByte,
    DefinitionWord.EndByte,
  ]);
  hash.words(module.typeWords, TYPE_WORD_LENGTH, [
    AlgebraicTypeWord.StartByte,
    AlgebraicTypeWord.EndByte,
  ]);
  hash.words(module.constructorWords, CONSTRUCTOR_WORD_LENGTH, [
    ConstructorWord.StartByte,
    ConstructorWord.EndByte,
  ]);
  hash.number(module.entrySymbol);
  hash.strings(module.symbolNames);
  hash.value(module.definitionTypes);
  hash.value(module.typeDeclarations);
  const fingerprint = hash.digest();
  fingerprints.set(module, fingerprint);
  return fingerprint;
}

export function registerEquivalentModuleFingerprint(
  reference: EncodedModule,
  equivalent: EncodedModule,
): void {
  fingerprints.set(equivalent, semanticModuleFingerprint(reference));
}

export function structuralFingerprint(
  value: unknown,
  options: { readonly includeSourceLocations?: boolean } = {},
): string {
  const hash = new StructuralHash(options.includeSourceLocations ?? false);
  hash.value(value);
  return hash.digest();
}

export function resolvedCoreStructuralFingerprint(
  module: CompiledModule,
  nodes: readonly CoreNode[],
): string {
  const cached = resolvedCoreFingerprints.get(module);
  if (cached !== undefined) return cached;

  const hash = new StructuralHash();
  hash.number(1);
  hash.number(nodes.length);
  for (const node of nodes) {
    hash.number(node.tag);
    hash.number(node.payload);
    hash.number(node.child0);
    hash.number(node.child1);
    hash.number(node.child2);
    hash.number(node.evaluationMode);
  }
  hash.strings(module.definitionNames);
  hash.value(module.definitionRoots);
  hash.strings(module.constructorNames);
  hash.value(module.constructorArities);
  hash.number(module.entryDefinition);
  hash.value(module.entryType);
  hash.value(effectNames(module.entryEffects));
  hash.value(module.declaredDefinitionEffects.map(effectNames));
  hash.value(module.definitionEffects.map(effectNames));
  hash.value(completeTypeDeclarations(module));
  hash.value(module.hostCapabilities.map((capability) => ({
    ...capability,
    fields: capability.fields.map((field) =>
      field.kind === "operation" ? { ...field, effects: effectNames(field.effects) } : field
    ),
  })));
  hash.value(module.hostDefinitions);
  hash.value(module.wasmExports.map((exported) => ({
    ...exported,
    effects: effectNames(exported.effects),
  })));
  hash.string(module.evaluationProfile);
  const fingerprint = hash.digest();
  resolvedCoreFingerprints.set(module, fingerprint);
  return fingerprint;
}

export function registerEquivalentResolvedCoreFingerprint(
  reference: CompiledModule,
  equivalent: CompiledModule,
): void {
  const fingerprint = resolvedCoreFingerprints.get(reference);
  if (fingerprint !== undefined) resolvedCoreFingerprints.set(equivalent, fingerprint);
}

class StructuralHash {
  #first = 0x811c9dc5;
  #second = 0x9e3779b9;
  #third = 0x85ebca6b;
  #fourth = 0xc2b2ae35;
  readonly #numberBytes = new DataView(new ArrayBuffer(8));

  constructor(private readonly includeSourceLocations = false) {}

  number(value: number): void {
    this.#tag(1);
    this.#numberBytes.setFloat64(0, value, true);
    this.#word(this.#numberBytes.getUint32(0, true));
    this.#word(this.#numberBytes.getUint32(4, true));
  }

  string(value: string): void {
    this.#tag(2);
    this.#word(value.length);
    for (let index = 0; index < value.length; index++) {
      this.#word(value.charCodeAt(index));
    }
  }

  strings(values: readonly string[]): void {
    this.#tag(3);
    this.#word(values.length);
    for (const value of values) this.string(value);
  }

  words(
    values: Uint32Array,
    recordLength = 1,
    ignoredFields: readonly number[] = [],
  ): void {
    this.#tag(4);
    this.#word(values.length);
    const ignored = new Set(ignoredFields);
    for (const [index, value] of values.entries()) {
      if (ignored.has(index % recordLength)) continue;
      this.#word(value);
    }
  }

  value(value: unknown): void {
    if (value === null) {
      this.#tag(5);
      return;
    }
    if (value === undefined) {
      this.#tag(6);
      return;
    }
    if (typeof value === "number") {
      this.number(value);
      return;
    }
    if (typeof value === "bigint") {
      this.#tag(7);
      this.string(value.toString());
      return;
    }
    if (typeof value === "boolean") {
      this.#tag(value ? 8 : 9);
      return;
    }
    if (typeof value === "string") {
      this.string(value);
      return;
    }
    if (value instanceof Uint8Array) {
      this.#tag(10);
      this.#word(value.length);
      for (const byte of value) this.#word(byte);
      return;
    }
    if (Array.isArray(value)) {
      this.#tag(11);
      this.#word(value.length);
      for (const child of value) this.value(child);
      return;
    }
    if (value instanceof Set) {
      this.value([...value].sort());
      return;
    }
    if (typeof value !== "object") {
      throw new TypeError(`cannot fingerprint value of type ${typeof value}`);
    }
    this.#tag(12);
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).filter((key) =>
      this.includeSourceLocations ||
      key !== "span" && key !== "startByte" && key !== "endByte" &&
        key !== "sourceByteOffset" && key !== "sourceEndByte"
    ).sort();
    this.#word(keys.length);
    for (const key of keys) {
      this.string(key);
      this.value(record[key]);
    }
  }

  digest(): string {
    return [this.#first, this.#second, this.#third, this.#fourth]
      .map((value) => value.toString(16).padStart(8, "0"))
      .join("");
  }

  #tag(value: number): void {
    this.#word(value);
  }

  #word(value: number): void {
    const word = value >>> 0;
    this.#first = Math.imul(this.#first ^ word, 0x01000193) >>> 0;
    this.#second = Math.imul(this.#second ^ word, 0x85ebca77) >>> 0;
    this.#third = Math.imul(this.#third ^ word, 0xc2b2ae3d) >>> 0;
    this.#fourth = Math.imul(this.#fourth ^ word, 0x27d4eb2f) >>> 0;
  }
}
