/// <reference lib="deno.worker" />

import type { GleamModule } from "./ast.ts";
import type { GleamDiagnostic } from "./diagnostic.ts";
import { GleamLoweringError, GleamSyntaxError } from "./diagnostic.ts";
import {
  type GleamExportSignature,
  gleamNominalExportSignatures,
  gleamValueExportSignatures,
  lowerGleamModule,
} from "./lowering.ts";
import { parseGleamModule } from "./parser.ts";
import {
  encodeLoweredGleamModule,
  transferableArrayBuffers,
  type TransferLoweredGleamModule,
} from "./project_frontend_transfer.ts";

export interface ProjectParseRequest {
  readonly phase: "parse";
  readonly sources: readonly {
    readonly index: number;
    readonly name: string;
    readonly source: string;
  }[];
}

export interface ProjectSignatureRequest {
  readonly phase: "signatures";
  readonly nominalSignatures: readonly GleamExportSignature[];
}

export interface ProjectLowerRequest {
  readonly phase: "lower";
  readonly signatures: readonly GleamExportSignature[];
}

export type ProjectFrontendWorkerRequest =
  | ProjectParseRequest
  | ProjectSignatureRequest
  | ProjectLowerRequest;

export interface ProjectParseResponse {
  readonly phase: "parse";
  readonly modules: readonly {
    readonly index: number;
    readonly name: string;
    readonly nominalSignatures: readonly GleamExportSignature[];
    readonly diagnostic?: GleamDiagnostic;
  }[];
}

export interface ProjectSignatureResponse {
  readonly phase: "signatures";
  readonly modules: readonly {
    readonly index: number;
    readonly signatures?: readonly GleamExportSignature[];
    readonly diagnostic?: GleamDiagnostic;
  }[];
}

export interface ProjectLowerResponse {
  readonly phase: "lower";
  readonly modules: readonly {
    readonly index: number;
    readonly lowered?: TransferLoweredGleamModule;
    readonly diagnostic?: GleamDiagnostic;
  }[];
}

export type ProjectFrontendWorkerResponse =
  | ProjectParseResponse
  | ProjectSignatureResponse
  | ProjectLowerResponse;

const parsedModules = new Map<number, GleamModule>();

self.onmessage = (event: MessageEvent<ProjectFrontendWorkerRequest>) => {
  const request = event.data;
  switch (request.phase) {
    case "parse": {
      parsedModules.clear();
      const modules = request.sources.map((source) => {
        try {
          const module = parseGleamModule(source.name, source.source);
          parsedModules.set(source.index, module);
          return {
            index: source.index,
            name: source.name,
            nominalSignatures: gleamNominalExportSignatures(module),
          };
        } catch (error) {
          if (!(error instanceof GleamSyntaxError)) throw error;
          return {
            index: source.index,
            name: source.name,
            nominalSignatures: [],
            diagnostic: {
              stage: "parse" as const,
              code: "G1001" as const,
              module: source.name,
              span: error.span,
              message: error.message,
            },
          };
        }
      });
      self.postMessage({ phase: "parse", modules } satisfies ProjectParseResponse);
      return;
    }
    case "signatures": {
      const modules = [...parsedModules].map(([index, module]) => {
        try {
          return {
            index,
            signatures: gleamValueExportSignatures(module, request.nominalSignatures),
          };
        } catch (error) {
          if (!(error instanceof GleamLoweringError)) throw error;
          return {
            index,
            diagnostic: {
              stage: "lower" as const,
              code: "G1002" as const,
              module: module.name,
              span: error.span,
              message: error.message,
            },
          };
        }
      });
      self.postMessage({ phase: "signatures", modules } satisfies ProjectSignatureResponse);
      return;
    }
    case "lower": {
      const modules = [...parsedModules].map(([index, module]) => {
        try {
          return {
            index,
            lowered: encodeLoweredGleamModule(lowerGleamModule(module, request.signatures)),
          };
        } catch (error) {
          if (!(error instanceof GleamLoweringError)) throw error;
          return {
            index,
            diagnostic: {
              stage: "lower" as const,
              code: "G1002" as const,
              module: module.name,
              span: error.span,
              message: error.message,
            },
          };
        }
      });
      const response = { phase: "lower", modules } satisfies ProjectLowerResponse;
      self.postMessage(response, { transfer: [...transferableArrayBuffers(response)] });
    }
  }
};
