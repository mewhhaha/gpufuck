import type { GleamModule } from "./ast.ts";
import { createOwnedModuleArtifact } from "../functional/module_linker.ts";
import {
  registerEquivalentModuleFingerprint,
  structuralFingerprint,
} from "../functional/semantic_fingerprint.ts";
import { type GleamDiagnostic, GleamSyntaxError } from "./diagnostic.ts";
import type { GleamFrontendResult, GleamSourceModule } from "./frontend.ts";
import { linkLoweredGleamModules, lowerGleamSources, lowerParsedGleamModules } from "./frontend.ts";
import {
  type GleamExportSignature,
  type LoweredGleamModule,
  lowerGleamModule,
} from "./lowering.ts";
import { parseGleamModule } from "./parser.ts";

interface CachedGleamProject {
  readonly sources: readonly GleamSourceModule[];
  readonly entryModule: string;
  readonly entryExport: string;
  readonly result: GleamFrontendResult;
}

export class GleamFrontendService {
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
    }
  >();
  #cachedProject: CachedGleamProject | undefined;

  lower(
    sources: readonly GleamSourceModule[],
    entry: { readonly module: string; readonly exportName: string },
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

    if (sources.length === 0 || repeatedModuleName(sources) !== undefined) {
      return this.#rememberProject(sources, entry, lowerGleamSources(sources, entry));
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
        const module = parseGleamModule(source.name, source.source);
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
      const previousModules = new Map(
        cached.result.lowered.modules.map((lowered) => [lowered.source.name, lowered]),
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
        const lowered = {
          ...previous,
          source: module,
          artifact: createOwnedModuleArtifact({
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
      const result = linkLoweredGleamModules(modules, loweredModules, entry);
      if (result.ok) {
        registerEquivalentModuleFingerprint(
          cached.result.lowered.module,
          result.lowered.module,
        );
      }
      return this.#rememberProject(sources, entry, result);
    }

    let signatureKey: string | undefined;
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
        const semantics = structuralFingerprint({
          imports: module.imports,
          declarations: module.declarations,
        });
        const locations = structuralFingerprint({
          imports: module.imports,
          declarations: module.declarations,
        }, { includeSourceLocations: true });
        const lowered = cachedLowering?.signatures === signatureKey &&
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
          : lowerGleamModule(module, signatures);
        this.#loweredModules.set(module.name, {
          source,
          signatures: signatureKey,
          semantics,
          locations,
          lowered,
        });
        return lowered;
      },
    );
    return this.#rememberProject(sources, entry, result);
  }

  #rememberProject(
    sources: readonly GleamSourceModule[],
    entry: { readonly module: string; readonly exportName: string },
    result: GleamFrontendResult,
  ): GleamFrontendResult {
    this.#cachedProject = {
      sources: sources.map(({ name, source }) => ({ name, source })),
      entryModule: entry.module,
      entryExport: entry.exportName,
      result,
    };
    return result;
  }

  clear(): void {
    this.#parsedModules.clear();
    this.#loweredModules.clear();
    this.#cachedProject = undefined;
  }
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
