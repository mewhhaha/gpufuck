import type { GleamModule } from "./ast.ts";
import {
  type CompilerPerformanceTrace,
  measureCompilerStage,
} from "../compiler_performance_trace.ts";
import { createOwnedModuleArtifact } from "../functional/module_linker.ts";
import {
  registerEquivalentModuleFingerprint,
  registerModuleFingerprint,
  structuralFingerprint,
} from "../functional/semantic_fingerprint.ts";
import {
  tryApplyLinkedLiteralUpdates,
  tryRegisterLiteralModuleUpdate,
} from "../functional/incremental_module.ts";
import { type GleamDiagnostic, GleamSyntaxError } from "./diagnostic.ts";
import type { GleamFrontendResult, GleamSourceModule } from "./frontend.ts";
import { linkLoweredGleamModules, lowerGleamSources, lowerParsedGleamModules } from "./frontend.ts";
import {
  type SignedIntegerChange,
  tryUpdateLoweredSignedIntegerLiterals,
} from "./incremental_lowering.ts";
import {
  type GleamExportSignature,
  type LoweredGleamModule,
  lowerGleamModule,
} from "./lowering.ts";
import { IncrementalGleamModuleParser, parsedIntegerUpdate } from "./parser.ts";

interface CachedGleamProject {
  readonly sources: readonly GleamSourceModule[];
  readonly entryModule: string;
  readonly entryExport: string;
  readonly result: GleamFrontendResult;
}

interface LiteralSemanticLineage {
  // Keeping the base key lets a reverted edit recover the exact original compiler cache entry.
  readonly baseSemantics: string;
  readonly baseValues: ReadonlyMap<string, bigint>;
  readonly currentValues: ReadonlyMap<string, bigint>;
}

interface CachedProjectSignatures {
  readonly modules: readonly GleamModule[];
  readonly signatures: readonly GleamExportSignature[];
  readonly key: string;
}

export interface GleamFrontendServiceLowerOptions {
  readonly trace?: CompilerPerformanceTrace;
}

export class GleamFrontendService {
  readonly #moduleParsers = new Map<string, IncrementalGleamModuleParser>();
  readonly #parsedModules = new Map<
    string,
    { readonly source: string; readonly module: GleamModule }
  >();
  readonly #loweredModules = new Map<
    string,
    {
      readonly source: string;
      readonly signatures: string;
      readonly semantics: string;
      readonly locations: string;
      readonly lowered: LoweredGleamModule;
      readonly literalLineage?: LiteralSemanticLineage;
    }
  >();
  #cachedProject: CachedGleamProject | undefined;
  #cachedSignatures: CachedProjectSignatures | undefined;

  lower(
    sources: readonly GleamSourceModule[],
    entry: { readonly module: string; readonly exportName: string },
    options: GleamFrontendServiceLowerOptions = {},
  ): GleamFrontendResult {
    const cached = this.#cachedProject;
    if (
      cached !== undefined &&
      cached.entryModule === entry.module &&
      cached.entryExport === entry.exportName &&
      sameSources(cached.sources, sources)
    ) {
      return cached.result;
    }
    const reusesProjectSemantics = cached !== undefined &&
      cached.entryModule === entry.module &&
      cached.entryExport === entry.exportName &&
      sameSourcesIgnoringTrailingTrivia(cached.sources, sources);

    const activeModules = new Set(sources.map((source) => source.name));
    for (const [name, parser] of this.#moduleParsers) {
      if (activeModules.has(name)) continue;
      parser.dispose();
      this.#moduleParsers.delete(name);
      this.#parsedModules.delete(name);
      this.#loweredModules.delete(name);
    }

    if (sources.length === 0 || repeatedModuleName(sources) !== undefined) {
      return this.#rememberProject(
        sources,
        entry,
        lowerGleamSources(sources, entry, options),
      );
    }

    const modules: GleamModule[] = [];
    for (const source of sources) {
      const cachedModule = this.#parsedModules.get(source.name);
      if (cachedModule?.source === source.source) {
        modules.push(cachedModule.module);
        continue;
      }
      if (
        cachedModule !== undefined &&
        sourcesDifferOnlyInTrailingTrivia(cachedModule.source, source.source)
      ) {
        const module = {
          ...cachedModule.module,
          span: {
            startByte: 0,
            endByte: new TextEncoder().encode(source.source).byteLength,
          },
        };
        this.#parsedModules.set(source.name, { source: source.source, module });
        modules.push(module);
        continue;
      }
      try {
        const moduleAnnotations = {
          module: source.name,
          sourceCharacters: source.source.length,
          declarations: 0,
          incremental: this.#moduleParsers.has(source.name),
        };
        const module = measureCompilerStage(
          options.trace,
          "frontend.parse.module",
          moduleAnnotations,
          () => {
            let parser = this.#moduleParsers.get(source.name);
            if (parser === undefined) {
              parser = new IncrementalGleamModuleParser(source.name, source.source);
              this.#moduleParsers.set(source.name, parser);
            } else {
              parser.update(source.source, options.trace);
            }
            return parser.parse(options.trace);
          },
          (parsed) => moduleAnnotations.declarations = parsed.declarations.length,
        );
        this.#parsedModules.set(source.name, { source: source.source, module });
        modules.push(module);
      } catch (error) {
        if (!(error instanceof GleamSyntaxError)) throw error;
        return this.#rememberProject(sources, entry, {
          ok: false,
          diagnostics: [syntaxDiagnostic(source.name, error)],
        });
      }
    }

    const sourceByModule = new Map(sources.map((source) => [source.name, source.source]));
    if (reusesProjectSemantics && cached?.result.ok) {
      const previousProject = cached.result.lowered;
      const previousModules = new Map(
        previousProject.modules.map((lowered) => [lowered.source.name, lowered]),
      );
      const loweredModules = modules.map((module): LoweredGleamModule => {
        const previous = previousModules.get(module.name);
        const cachedLowering = this.#loweredModules.get(module.name);
        if (previous === undefined || cachedLowering === undefined) {
          throw new Error(`Gleam frontend service omitted cached module ${module.name}`);
        }
        const source = sourceByModule.get(module.name);
        if (source === undefined) {
          throw new Error(`Gleam frontend service omitted source for module ${module.name}`);
        }
        if (cachedLowering.source === source) return previous;
        const sourceGeometryUnchanged = previous.artifact.sourceByteLength === module.span.endByte;
        const lowered = {
          ...previous,
          source: module,
          artifact: sourceGeometryUnchanged ? previous.artifact : createOwnedModuleArtifact({
            ...previous.artifact,
            sourceByteLength: module.span.endByte,
          }),
        };
        this.#loweredModules.set(module.name, {
          ...cachedLowering,
          source,
          lowered,
        });
        return lowered;
      });
      const sourceGeometryUnchanged = loweredModules.every((lowered, index) =>
        lowered.artifact.sourceByteLength ===
          previousProject.modules[index]?.artifact.sourceByteLength
      );
      if (this.#cachedSignatures !== undefined) {
        this.#cachedSignatures = {
          ...this.#cachedSignatures,
          modules: Object.freeze([...modules]),
        };
      }
      if (sourceGeometryUnchanged) {
        const linked = measureCompilerStage(
          options.trace,
          "frontend.link",
          {
            modules: previousProject.linked.sources.length,
            nodes: previousProject.module.nodeCount,
            definitions: previousProject.module.definitionCount,
            types: previousProject.module.typeCount,
            cacheHit: true,
          },
          () => previousProject.linked,
        );
        return this.#rememberProject(sources, entry, {
          ok: true,
          lowered: {
            modules: loweredModules,
            linked,
            module: linked.module,
          },
        });
      }
      const result = linkLoweredGleamModules(modules, loweredModules, entry, options.trace);
      if (result.ok) {
        registerEquivalentModuleFingerprint(
          previousProject.module,
          result.lowered.module,
        );
      }
      return this.#rememberProject(sources, entry, result);
    }

    const cachedSignatures = this.#cachedSignatures;
    const reusableSignatures = cachedSignatures !== undefined &&
        cachedSignatures.modules.length === modules.length &&
        modules.every((module, index) => {
          const previous = cachedSignatures.modules[index];
          return module === previous || parsedIntegerUpdate(module) === previous;
        })
      ? cachedSignatures
      : undefined;
    let signatureKey: string | undefined = reusableSignatures?.key;
    let projectSignatures: readonly GleamExportSignature[] | undefined;
    const previousLinkedProject = cached?.result.ok ? cached.result.lowered : undefined;
    const result = lowerParsedGleamModules(
      modules,
      entry,
      (
        module: GleamModule,
        signatures: readonly GleamExportSignature[],
      ): LoweredGleamModule => {
        signatureKey ??= structuralFingerprint(signatures);
        const source = sourceByModule.get(module.name);
        if (source === undefined) {
          throw new Error(`Gleam frontend service omitted source for module ${module.name}`);
        }
        const cachedLowering = this.#loweredModules.get(module.name);
        if (
          cachedLowering?.source === source &&
          cachedLowering.signatures === signatureKey
        ) {
          return cachedLowering.lowered;
        }
        const literalUpdateAnnotations = { changedLiterals: 0 };
        const literalUpdate = cachedLowering?.signatures === signatureKey
          ? measureCompilerStage(
            options.trace,
            "frontend.lower.literal-update",
            literalUpdateAnnotations,
            () =>
              tryUpdateLoweredSignedIntegerLiterals(
                cachedLowering.lowered,
                module,
              ),
            (updated) => {
              literalUpdateAnnotations.changedLiterals = updated?.changedLiterals ?? 0;
            },
          )
          : undefined;
        const literalLineage = literalUpdate === undefined || cachedLowering === undefined
          ? undefined
          : updateLiteralSemanticLineage(
            cachedLowering.literalLineage,
            cachedLowering.semantics,
            literalUpdate.literalChanges,
          );
        const fingerprintAnnotations = {
          incremental: literalLineage !== undefined,
          changedLiterals: literalUpdate?.changedLiterals ?? 0,
        };
        const semantics = measureCompilerStage(
          options.trace,
          "frontend.lower.semantic-fingerprint",
          fingerprintAnnotations,
          () =>
            literalLineage === undefined
              ? structuralFingerprint({
                imports: module.imports,
                declarations: module.declarations,
              })
              : literalSemanticFingerprint(literalLineage),
        );
        const locations = literalUpdate === undefined || cachedLowering === undefined
          ? structuralFingerprint({
            imports: module.imports,
            declarations: module.declarations,
          }, { includeSourceLocations: true })
          : cachedLowering.locations;
        const lowered = literalUpdate?.lowered ??
          (cachedLowering?.signatures === signatureKey &&
              cachedLowering.semantics === semantics &&
              cachedLowering.locations === locations
            ? {
              ...cachedLowering.lowered,
              source: module,
              artifact: createOwnedModuleArtifact({
                ...cachedLowering.lowered.artifact,
                sourceByteLength: module.span.endByte,
              }),
            }
            : lowerGleamModule(module, signatures));
        this.#loweredModules.set(module.name, {
          source,
          signatures: signatureKey,
          semantics,
          locations,
          lowered,
          ...(literalLineage === undefined ? {} : { literalLineage }),
        });
        return lowered;
      },
      {
        ...(options.trace === undefined ? {} : { trace: options.trace }),
        ...(reusableSignatures === undefined ? {} : { signatures: reusableSignatures.signatures }),
        captureSignatures: (signatures) => projectSignatures = signatures,
        link: (parsedModules, loweredModules, projectEntry, trace) => {
          if (previousLinkedProject !== undefined) {
            const updateAnnotations = { modules: loweredModules.length, changedNodes: 0 };
            const update = measureCompilerStage(
              trace,
              "frontend.link.literal-update",
              updateAnnotations,
              () =>
                tryApplyLinkedLiteralUpdates(
                  previousLinkedProject.linked,
                  previousLinkedProject.modules.map((lowered) => lowered.artifact),
                  loweredModules.map((lowered) => lowered.artifact),
                ),
              (literalUpdate) => {
                updateAnnotations.changedNodes = literalUpdate?.changedNodes ?? 0;
              },
            );
            if (update !== undefined) {
              return {
                ok: true,
                lowered: {
                  modules: loweredModules,
                  linked: update.linked,
                  module: update.linked.module,
                },
              };
            }
          }
          return linkLoweredGleamModules(parsedModules, loweredModules, projectEntry, trace);
        },
      },
    );
    if (result.ok) {
      if (signatureKey === undefined || projectSignatures === undefined) {
        throw new Error("Gleam frontend service omitted project signatures after lowering");
      }
      this.#cachedSignatures = {
        modules: Object.freeze([...modules]),
        signatures: projectSignatures,
        key: signatureKey,
      };
      const moduleSemantics = result.lowered.modules.map((lowered) => {
        const cachedLowering = this.#loweredModules.get(lowered.source.name);
        if (cachedLowering === undefined) {
          throw new Error(
            `Gleam frontend service omitted lowered module ${lowered.source.name}`,
          );
        }
        return {
          name: lowered.source.name,
          semantics: cachedLowering.semantics,
        };
      });
      registerModuleFingerprint(
        result.lowered.module,
        `gleam-project-v1:${
          structuralFingerprint({
            entryModule: entry.module,
            entryExport: entry.exportName,
            signatures: signatureKey,
            modules: moduleSemantics,
          })
        }`,
      );
      if (cached?.result.ok) {
        tryRegisterLiteralModuleUpdate(
          cached.result.lowered.module,
          result.lowered.module,
        );
      }
    }
    return this.#rememberProject(sources, entry, result);
  }

  #rememberProject(
    sources: readonly GleamSourceModule[],
    entry: { readonly module: string; readonly exportName: string },
    result: GleamFrontendResult,
  ): GleamFrontendResult {
    if (!result.ok) this.#cachedSignatures = undefined;
    this.#cachedProject = {
      sources: sources.map(({ name, source }) => ({ name, source })),
      entryModule: entry.module,
      entryExport: entry.exportName,
      result,
    };
    return result;
  }

  clear(): void {
    for (const parser of this.#moduleParsers.values()) parser.dispose();
    this.#moduleParsers.clear();
    this.#parsedModules.clear();
    this.#loweredModules.clear();
    this.#cachedProject = undefined;
    this.#cachedSignatures = undefined;
  }
}

function updateLiteralSemanticLineage(
  previous: LiteralSemanticLineage | undefined,
  previousSemantics: string,
  changes: readonly SignedIntegerChange[],
): LiteralSemanticLineage {
  const baseSemantics = previous?.baseSemantics ?? previousSemantics;
  const baseValues = new Map(previous?.baseValues ?? []);
  const currentValues = new Map(previous?.currentValues ?? []);
  for (const change of changes) {
    const key = `${change.startByte}:${change.endByte}`;
    const baseValue = baseValues.get(key);
    const currentValue = currentValues.get(key) ?? baseValue ?? change.previousValue;
    if (currentValue !== change.previousValue) {
      throw new Error(
        `Gleam literal fingerprint expected ${currentValue} at bytes ${key}; received ${change.previousValue}`,
      );
    }
    if (baseValue === undefined) baseValues.set(key, change.previousValue);
    currentValues.set(key, change.updatedValue);
  }
  return { baseSemantics, baseValues, currentValues };
}

function literalSemanticFingerprint(lineage: LiteralSemanticLineage): string {
  const deviations = [...lineage.currentValues]
    .filter(([key, value]) => value !== lineage.baseValues.get(key))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}:${value}`);
  return deviations.length === 0
    ? lineage.baseSemantics
    : `gleam-literal-v1:${lineage.baseSemantics}:${structuralFingerprint(deviations)}`;
}

function sourcesDifferOnlyInTrailingTrivia(previous: string, current: string): boolean {
  if (previous === current) return true;
  const previousEnd = trailingTriviaStart(previous);
  const currentEnd = trailingTriviaStart(current);
  return previousEnd === currentEnd &&
    previous.slice(0, previousEnd) === current.slice(0, currentEnd);
}

function trailingTriviaStart(source: string): number {
  let semanticEnd = 0;
  let inString = false;
  let escaped = false;
  let inComment = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (inComment) {
      if (character === "\n" || character === "\r") inComment = false;
      continue;
    }
    if (inString) {
      semanticEnd = index + 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      inComment = true;
      index++;
      continue;
    }
    if (character === '"') {
      inString = true;
      semanticEnd = index + 1;
      continue;
    }
    if (
      character !== " " && character !== "\t" && character !== "\n" &&
      character !== "\r" && character !== "\f" && character !== "\v"
    ) {
      semanticEnd = index + 1;
    }
  }
  return semanticEnd;
}

function repeatedModuleName(sources: readonly GleamSourceModule[]): string | undefined {
  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name)) return source.name;
    names.add(source.name);
  }
  return undefined;
}

function syntaxDiagnostic(module: string, error: GleamSyntaxError): GleamDiagnostic {
  return {
    stage: "parse",
    code: "G1001",
    module,
    span: error.span,
    message: error.message,
  };
}

function sameSources(
  left: readonly GleamSourceModule[],
  right: readonly GleamSourceModule[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((source, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      source.name === candidate.name &&
      source.source === candidate.source;
  });
}

function sameSourcesIgnoringTrailingTrivia(
  left: readonly GleamSourceModule[],
  right: readonly GleamSourceModule[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((source, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      source.name === candidate.name &&
      sourcesDifferOnlyInTrailingTrivia(source.source, candidate.source);
  });
}
