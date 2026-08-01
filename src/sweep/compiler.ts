import {
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type EncodedModule,
  EvaluationMode,
  ExpressionTag,
  type GpuModule,
  NO_INDEX,
  NODE_WORD_LENGTH,
  NodeWord,
  restoreCompiledCore,
} from "../../functional.ts";
import type { CompiledCoreArtifact } from "../functional/core_artifact.ts";
import { concreteType } from "../functional/schema_contract.ts";
import type { CoreNode } from "../semantic/compiler_module.ts";
import {
  createSymbolLookup,
  INDEXED_LOCAL_RESOLUTION_MAGIC,
  SYMBOL_LOOKUP_WORD_LENGTH,
  SymbolLookupWord,
} from "../semantic/symbol_lookup.ts";
import { createSweepCheckingPlan } from "./checking_plan.ts";
import { GpuSweepChecker } from "./gpu_checker.ts";
import { lowerSweepModule } from "./lowering.ts";
import { parseSweepModule, type SweepDiagnostic } from "./parser.ts";

export type GpuSweepCompileResult =
  | {
    readonly ok: true;
    readonly module: GpuModule;
    readonly constraintCount: number;
    readonly checkingMilliseconds: number;
  }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [SweepDiagnostic, ...SweepDiagnostic[]];
  };

export class GpuSweepCompiler {
  readonly #device: GPUDevice;
  readonly #checker: GpuSweepChecker;

  private constructor(device: GPUDevice, checker: GpuSweepChecker) {
    this.#device = device;
    this.#checker = checker;
  }

  static async create(device: GPUDevice): Promise<GpuSweepCompiler> {
    return new GpuSweepCompiler(device, await GpuSweepChecker.create(device));
  }

  async compileSource(name: string, source: string): Promise<GpuSweepCompileResult> {
    const parsed = parseSweepModule(name, source);
    if (!parsed.ok) return { ok: false, diagnostics: asDiagnosticTuple(parsed.diagnostics) };
    const sourceByteLength = new TextEncoder().encode(source).byteLength;
    const lowered = lowerSweepModule(parsed.module, sourceByteLength);
    if (!lowered.ok) return { ok: false, diagnostics: asDiagnosticTuple(lowered.diagnostics) };
    const planned = createSweepCheckingPlan(parsed.module);
    if (!planned.ok) return { ok: false, diagnostics: asDiagnosticTuple(planned.diagnostics) };
    const checked = await this.#checker.check(planned.plan);
    if (!checked.ok) return { ok: false, diagnostics: checked.diagnostics };
    const module = await restoreCompiledCore(
      this.#device,
      lowered.module,
      resolvedSweepCore(lowered.module),
    );
    return {
      ok: true,
      module,
      constraintCount: checked.constraintCount,
      checkingMilliseconds: checked.milliseconds,
    };
  }
}

function resolvedSweepCore(module: EncodedModule): CompiledCoreArtifact {
  const lookup = createSymbolLookup(module);
  const header = module.symbolNames.length * SYMBOL_LOOKUP_WORD_LENGTH;
  if (lookup[header + SymbolLookupWord.Definition] !== INDEXED_LOCAL_RESOLUTION_MAGIC) {
    throw new Error(
      `Sweep checking-only compilation could not resolve ${module.nodeCount} Core nodes`,
    );
  }
  const errorNode = lookup[header + SymbolLookupWord.CaseNode];
  if (errorNode === undefined) {
    throw new Error("Sweep checking-only compilation omitted its Core resolution status");
  }
  if (errorNode !== NO_INDEX) {
    const record = (module.symbolNames.length + 1 + errorNode) * SYMBOL_LOOKUP_WORD_LENGTH;
    const errorCode = lookup[record + SymbolLookupWord.Constructor];
    const errorDetail = lookup[record + SymbolLookupWord.CaseNode];
    throw new Error(
      `Sweep checking plan produced unresolved Core node ${errorNode}: error=${errorCode}, detail=${errorDetail}`,
    );
  }
  const nodes = Object.freeze(Array.from({ length: module.nodeCount }, (_, node): CoreNode => {
    const surface = node * NODE_WORD_LENGTH;
    const lowering = (module.symbolNames.length + 1 + node) * SYMBOL_LOOKUP_WORD_LENGTH;
    const tag = lookup[lowering + SymbolLookupWord.Definition];
    const payload = lookup[lowering + SymbolLookupWord.Type];
    const surfaceTag = module.nodeWords[surface + NodeWord.Tag];
    if (tag === undefined || payload === undefined || surfaceTag === undefined) {
      throw new Error(`Sweep checking plan omitted Core node ${node}`);
    }
    return Object.freeze({
      tag: tag as CoreNode["tag"],
      payload,
      child0: module.nodeWords[surface + NodeWord.Child0] ?? NO_INDEX,
      child1: module.nodeWords[surface + NodeWord.Child1] ?? NO_INDEX,
      child2: module.nodeWords[surface + NodeWord.Child2] ?? NO_INDEX,
      sourceByteOffset: module.nodeWords[surface + NodeWord.StartByte] ?? 0,
      sourceEndByte: module.nodeWords[surface + NodeWord.EndByte] ?? 0,
      evaluationMode: surfaceTag === ExpressionTag.Sequence
        ? EvaluationMode.StrictEager
        : EvaluationMode.LazyCallByNeed,
    });
  }));
  const entryDefinition = entryDefinitionIndex(module);
  const annotation = module.definitionTypes[entryDefinition]?.annotation;
  if (annotation === null || annotation === undefined) {
    throw new Error(`Sweep entry definition ${entryDefinition} has no type annotation`);
  }
  return { nodes, entryType: concreteType(annotation) };
}

function entryDefinitionIndex(module: EncodedModule): number {
  for (let definition = 0; definition < module.definitionCount; definition++) {
    const symbol = module.definitionWords[
      definition * DEFINITION_WORD_LENGTH + DefinitionWord.Symbol
    ];
    if (symbol === module.entrySymbol) return definition;
  }
  throw new Error(
    `Sweep entry symbol ${module.entrySymbol} is absent from ${module.definitionCount} definitions`,
  );
}

function asDiagnosticTuple(
  diagnostics: readonly SweepDiagnostic[],
): readonly [SweepDiagnostic, ...SweepDiagnostic[]] {
  const first = diagnostics[0];
  if (first === undefined) throw new Error("Sweep compilation failed without a diagnostic");
  return [first, ...diagnostics.slice(1)];
}
