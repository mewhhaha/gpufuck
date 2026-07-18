import type { EncodedFunctionalModule } from "../functional/abi.ts";
import {
  FunctionalLinkError,
  type LinkedFunctionalModule,
  linkFunctionalModules,
} from "../functional/module_linker.ts";
import type { GleamFunctionalModule } from "./ast.ts";
import {
  type GleamFunctionalDiagnostic,
  GleamFunctionalLoweringError,
  GleamFunctionalSyntaxError,
} from "./diagnostic.ts";
import {
  type GleamFunctionalExportSignature,
  gleamFunctionalExportSignatures,
  type LoweredGleamFunctionalModule,
  lowerGleamFunctionalModule,
} from "./lowering.ts";
import { parseGleamFunctionalModule } from "./parser.ts";

export interface GleamFunctionalSourceModule {
  readonly name: string;
  readonly source: string;
}

export interface LoweredGleamFunctionalProgram {
  readonly modules: readonly LoweredGleamFunctionalModule[];
  readonly linked: LinkedFunctionalModule;
  readonly module: EncodedFunctionalModule;
}

export type GleamFunctionalFrontendResult =
  | { readonly ok: true; readonly lowered: LoweredGleamFunctionalProgram }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [GleamFunctionalDiagnostic, ...GleamFunctionalDiagnostic[]];
  };

export function lowerGleamFunctionalSources(
  sources: readonly GleamFunctionalSourceModule[],
  entry: { readonly module: string; readonly exportName: string },
): GleamFunctionalFrontendResult {
  if (sources.length === 0) {
    return {
      ok: false,
      diagnostics: [{
        stage: "parse",
        code: "G1001",
        module: entry.module,
        span: { startByte: 0, endByte: 0 },
        message: "Gleam functional compilation requires at least one source module.",
      }],
    };
  }

  const modules: GleamFunctionalModule[] = [];
  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name)) {
      return {
        ok: false,
        diagnostics: [{
          stage: "parse",
          code: "G1001",
          module: source.name,
          span: { startByte: 0, endByte: 0 },
          message: `Gleam functional sources repeat module ${JSON.stringify(source.name)}.`,
        }],
      };
    }
    names.add(source.name);
    try {
      modules.push(parseGleamFunctionalModule(source.name, source.source));
    } catch (error) {
      if (error instanceof GleamFunctionalSyntaxError) {
        return {
          ok: false,
          diagnostics: [{
            stage: "parse",
            code: "G1001",
            module: source.name,
            span: error.span,
            message: error.message,
          }],
        };
      }
      throw error;
    }
  }

  const signatures: GleamFunctionalExportSignature[] = [];
  for (const module of modules) {
    try {
      signatures.push(...gleamFunctionalExportSignatures(module));
    } catch (error) {
      if (error instanceof GleamFunctionalLoweringError) {
        return { ok: false, diagnostics: [lowerDiagnostic(module.name, error)] };
      }
      throw error;
    }
  }

  const loweredModules: LoweredGleamFunctionalModule[] = [];
  for (const module of modules) {
    try {
      loweredModules.push(lowerGleamFunctionalModule(module, signatures));
    } catch (error) {
      if (error instanceof GleamFunctionalLoweringError) {
        return { ok: false, diagnostics: [lowerDiagnostic(module.name, error)] };
      }
      throw error;
    }
  }

  try {
    const linked = linkFunctionalModules(
      loweredModules.map((lowered) => lowered.artifact),
      entry,
    );
    return {
      ok: true,
      lowered: { modules: loweredModules, linked, module: linked.module },
    };
  } catch (error) {
    if (error instanceof FunctionalLinkError) {
      const module = modules.find((candidate) => candidate.name === error.module) ?? modules[0]!;
      return {
        ok: false,
        diagnostics: [{
          stage: "link",
          code: "G1003",
          module: module.name,
          span: module.span,
          message: error.message,
        }],
      };
    }
    throw error;
  }
}

export function lowerGleamFunctionalSource(
  name: string,
  source: string,
  exportName = "main",
): GleamFunctionalFrontendResult {
  return lowerGleamFunctionalSources([{ name, source }], { module: name, exportName });
}

function lowerDiagnostic(
  module: string,
  error: GleamFunctionalLoweringError,
): GleamFunctionalDiagnostic {
  return {
    stage: "lower",
    code: "G1002",
    module,
    span: error.span,
    message: error.message,
  };
}
