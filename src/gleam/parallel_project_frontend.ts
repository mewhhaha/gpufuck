import type { GleamDiagnostic } from "./diagnostic.ts";
import {
  type GleamFrontendResult,
  type GleamSourceModule,
  linkLoweredGleamModules,
  lowerGleamSources,
} from "./frontend.ts";
import type { GleamExportSignature, LoweredGleamModule } from "./lowering.ts";
import type {
  ProjectFrontendWorkerRequest,
  ProjectFrontendWorkerResponse,
  ProjectLowerResponse,
  ProjectParseResponse,
  ProjectSignatureResponse,
} from "./parallel_project_frontend_worker.ts";
import { decodeLoweredGleamModule } from "./project_frontend_transfer.ts";
import { sizeBalancedBatches } from "./worker_batches.ts";

const MINIMUM_PARALLEL_PROJECT_MODULES = 4;

interface CachedProject {
  readonly sources: readonly GleamSourceModule[];
  readonly entryModule: string;
  readonly entryExport: string;
  readonly result: GleamFrontendResult;
}

/**
 * Parses, extracts signatures, and lowers the modules of one linked Gleam project in workers.
 *
 * Linking and semantic inference remain whole-project operations so unannotated public functions
 * retain the same cross-module inference behavior as the serial frontend.
 */
export class ParallelGleamProjectFrontend {
  readonly #workerCount: number;
  readonly #workers: Worker[] = [];
  #active = false;
  #cachedProject: CachedProject | undefined;
  #terminated = false;

  private constructor(workerCount: number) {
    this.#workerCount = workerCount;
  }

  static create(workerCount?: number): ParallelGleamProjectFrontend {
    const available = navigator.hardwareConcurrency ?? 4;
    const count = Math.max(1, workerCount ?? Math.max(1, available - 1));
    return new ParallelGleamProjectFrontend(count);
  }

  async lower(
    sources: readonly GleamSourceModule[],
    entry: { readonly module: string; readonly exportName: string },
  ): Promise<GleamFrontendResult> {
    if (this.#terminated) throw new Error("parallel Gleam project frontend was already terminated");
    if (this.#active) {
      throw new Error("parallel Gleam project frontend cannot lower concurrent projects");
    }
    const cached = this.#cachedProject;
    if (
      cached !== undefined &&
      cached.entryModule === entry.module &&
      cached.entryExport === entry.exportName &&
      sameSources(cached.sources, sources)
    ) {
      return cached.result;
    }
    if (
      sources.length < MINIMUM_PARALLEL_PROJECT_MODULES ||
      new Set(sources.map((source) => source.name)).size !== sources.length
    ) {
      return this.#remember(sources, entry, lowerGleamSources(sources, entry));
    }

    this.#active = true;
    try {
      const workers = this.#ensureWorkers();
      const batches = sizeBalancedBatches(
        sources,
        workers.length,
        (source) => source.source.length,
      );
      const activeWorkers = workers.slice(0, batches.length);
      const parseResponses = await Promise.all(
        activeWorkers.map((worker, workerIndex) =>
          this.#request(worker, {
            phase: "parse",
            sources: (batches[workerIndex] ?? []).map(({ index, value }) => ({
              index,
              name: value.name,
              source: value.source,
            })),
          }, "parse")
        ),
      );
      const parseDiagnostics = diagnostics(parseResponses);
      if (parseDiagnostics.length > 0) {
        return this.#remember(sources, entry, {
          ok: false,
          diagnostics: parseDiagnostics as [GleamDiagnostic, ...GleamDiagnostic[]],
        });
      }

      const nominalSignatures = orderedSignatures(
        sources.length,
        parseResponses.flatMap((response) =>
          response.modules.map((module) => ({
            index: module.index,
            signatures: module.nominalSignatures,
          }))
        ),
      );
      const signatureResponses = await Promise.all(
        activeWorkers.map((worker) =>
          this.#request(worker, {
            phase: "signatures",
            nominalSignatures,
          }, "signatures")
        ),
      );
      const signatureDiagnostics = diagnostics(signatureResponses);
      if (signatureDiagnostics.length > 0) {
        return this.#remember(sources, entry, {
          ok: false,
          diagnostics: signatureDiagnostics as [GleamDiagnostic, ...GleamDiagnostic[]],
        });
      }
      const valueSignatures = orderedSignatures(
        sources.length,
        signatureResponses.flatMap((response) =>
          response.modules.map((module) => ({
            index: module.index,
            signatures: module.signatures ?? [],
          }))
        ),
      );
      const signatures = [...nominalSignatures, ...valueSignatures];
      const lowerResponses = await Promise.all(
        activeWorkers.map((worker) =>
          this.#request(worker, { phase: "lower", signatures }, "lower")
        ),
      );
      const lowerDiagnostics = diagnostics(lowerResponses);
      if (lowerDiagnostics.length > 0) {
        return this.#remember(sources, entry, {
          ok: false,
          diagnostics: lowerDiagnostics as [GleamDiagnostic, ...GleamDiagnostic[]],
        });
      }
      const lowered = new Array<LoweredGleamModule | undefined>(sources.length);
      for (const response of lowerResponses) {
        for (const module of response.modules) {
          if (module.lowered !== undefined) {
            lowered[module.index] = decodeLoweredGleamModule(module.lowered);
          }
        }
      }
      const complete = lowered.map((module, index) => {
        if (module === undefined) {
          throw new Error(`parallel Gleam project frontend dropped module ${index}`);
        }
        return module;
      });
      const result = linkLoweredGleamModules(
        complete.map((module) => module.source),
        complete,
        entry,
      );
      return this.#remember(sources, entry, result);
    } finally {
      this.#active = false;
    }
  }

  clear(): void {
    this.#cachedProject = undefined;
  }

  terminate(): void {
    for (const worker of this.#workers) worker.terminate();
    this.#workers.length = 0;
    this.#cachedProject = undefined;
    this.#terminated = true;
  }

  #ensureWorkers(): readonly Worker[] {
    if (this.#workers.length > 0) return this.#workers;
    const url = new URL("./parallel_project_frontend_worker.ts", import.meta.url);
    for (let index = 0; index < this.#workerCount; index++) {
      this.#workers.push(new Worker(url, { type: "module" }));
    }
    return this.#workers;
  }

  #request<Phase extends ProjectFrontendWorkerResponse["phase"]>(
    worker: Worker,
    request: ProjectFrontendWorkerRequest,
    phase: Phase,
  ): Promise<Extract<ProjectFrontendWorkerResponse, { readonly phase: Phase }>> {
    return new Promise((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ProjectFrontendWorkerResponse>) => {
        if (event.data.phase !== phase) {
          reject(
            new Error(
              `parallel Gleam project worker returned ${event.data.phase} during ${phase}`,
            ),
          );
          return;
        }
        resolve(
          event.data as Extract<
            ProjectFrontendWorkerResponse,
            { readonly phase: Phase }
          >,
        );
      };
      worker.onerror = (event) =>
        reject(new Error(`parallel Gleam project worker failed: ${event.message}`));
      worker.postMessage(request);
    });
  }

  #remember(
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
}

type PhaseResponse =
  | ProjectParseResponse
  | ProjectSignatureResponse
  | ProjectLowerResponse;

function diagnostics(responses: readonly PhaseResponse[]): GleamDiagnostic[] {
  const found: { readonly index: number; readonly diagnostic: GleamDiagnostic }[] = [];
  for (const response of responses) {
    for (const module of response.modules) {
      if (module.diagnostic !== undefined) {
        found.push({ index: module.index, diagnostic: module.diagnostic });
      }
    }
  }
  return found
    .sort((left, right) => left.index - right.index)
    .map(({ diagnostic }) => diagnostic);
}

function orderedSignatures(
  moduleCount: number,
  modules: readonly {
    readonly index: number;
    readonly signatures: readonly GleamExportSignature[];
  }[],
): readonly GleamExportSignature[] {
  const signatures = new Array<readonly GleamExportSignature[] | undefined>(moduleCount);
  for (const module of modules) signatures[module.index] = module.signatures;
  return signatures.flatMap((moduleSignatures, index) => {
    if (moduleSignatures === undefined) {
      throw new Error(`parallel Gleam project signatures omitted module ${index}`);
    }
    return moduleSignatures;
  });
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
