import type { GleamModule } from "./ast.ts";
import { type GleamDiagnostic, GleamSyntaxError } from "./diagnostic.ts";
import type { GleamFrontendResult, GleamSourceModule } from "./frontend.ts";
import { lowerGleamSources, lowerParsedGleamModules } from "./frontend.ts";
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

    let signatureKey: string | undefined;
    const sourceByModule = new Map(sources.map((source) => [source.name, source.source]));
    const result = lowerParsedGleamModules(
      modules,
      entry,
      (
        module: GleamModule,
        signatures: readonly GleamExportSignature[],
      ): LoweredGleamModule => {
        signatureKey ??= JSON.stringify(signatures);
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
        const lowered = lowerGleamModule(module, signatures);
        this.#loweredModules.set(module.name, {
          source,
          signatures: signatureKey,
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
