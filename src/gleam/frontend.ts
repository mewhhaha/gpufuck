import { type EncodedModule, UNIT_CONSTRUCTOR_NAME } from "../functional/abi.ts";
import {
  createModuleArtifact,
  type LinkedModule,
  LinkError,
  linkModules,
} from "../functional/module_linker.ts";
import type { GleamModule } from "./ast.ts";
import { type GleamDiagnostic, GleamLoweringError, GleamSyntaxError } from "./diagnostic.ts";
import {
  type GleamExportSignature,
  gleamNominalExportSignatures,
  gleamPreludeArtifact,
  gleamValueExportSignatures,
  type LoweredGleamModule,
  lowerGleamModule,
} from "./lowering.ts";
import { parseGleamModule } from "./parser.ts";

export interface GleamSourceModule {
  readonly name: string;
  readonly source: string;
}

export interface LoweredGleamProgram {
  readonly modules: readonly LoweredGleamModule[];
  readonly linked: LinkedModule;
  readonly module: EncodedModule;
}

export type GleamFrontendResult =
  | { readonly ok: true; readonly lowered: LoweredGleamProgram }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [GleamDiagnostic, ...GleamDiagnostic[]];
  };

export function lowerGleamSources(
  sources: readonly GleamSourceModule[],
  entry: { readonly module: string; readonly exportName: string },
): GleamFrontendResult {
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

  const modules: GleamModule[] = [];
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
      modules.push(parseGleamModule(source.name, source.source));
    } catch (error) {
      if (error instanceof GleamSyntaxError) {
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

  const signatures: GleamExportSignature[] = [];
  for (const module of modules) {
    signatures.push(...gleamNominalExportSignatures(module));
  }
  for (const module of modules) {
    try {
      signatures.push(...gleamValueExportSignatures(module, signatures));
    } catch (error) {
      if (error instanceof GleamLoweringError) {
        return { ok: false, diagnostics: [lowerDiagnostic(module.name, error)] };
      }
      throw error;
    }
  }

  const loweredModules: LoweredGleamModule[] = [];
  for (const module of modules) {
    try {
      loweredModules.push(lowerGleamModule(module, signatures));
    } catch (error) {
      if (error instanceof GleamLoweringError) {
        return { ok: false, diagnostics: [lowerDiagnostic(module.name, error)] };
      }
      throw error;
    }
  }

  try {
    const entryModule = modules.find((module) => module.name === entry.module);
    const entryDeclaration = entryModule?.declarations.find((declaration) =>
      declaration.public && declaration.name === entry.exportName
    );
    const invokesZeroArgumentFunction = entryDeclaration?.kind === "function" &&
      entryDeclaration.parameters.length === 0;
    const entryArtifact = invokesZeroArgumentFunction
      ? createModuleArtifact({
        name: "$gleam/entry",
        definitions: [{
          name: "main",
          parameters: [],
          annotation: null,
          body: {
            kind: "apply",
            callee: { kind: "name", name: "sourceEntry" },
            arguments: [{ kind: "name", name: UNIT_CONSTRUCTOR_NAME }],
          },
        }],
        typeDeclarations: [],
        imports: [{
          name: "sourceEntry",
          fromModule: entry.module,
          exportName: entry.exportName,
        }],
        exports: [{ name: "main", definition: "main" }],
        sourceByteLength: 0,
        options: {},
      })
      : null;
    const linked = linkModules(
      [
        gleamPreludeArtifact(),
        ...loweredModules.map((lowered) => lowered.artifact),
        ...(entryArtifact === null ? [] : [entryArtifact]),
      ],
      entryArtifact === null ? entry : { module: entryArtifact.name, exportName: "main" },
    );
    return {
      ok: true,
      lowered: { modules: loweredModules, linked, module: linked.module },
    };
  } catch (error) {
    if (error instanceof LinkError) {
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
    // A packed-ABI limit — the 65,536-node cap on a surface module is the one reached in practice —
    // arrives as a bare RangeError from surface packing. Returning it as a diagnostic keeps this
    // function's contract single: every failure a caller can be handed comes back as a result, so
    // driving it over many modules does not need a try/catch to avoid losing the rest of the batch.
    if (error instanceof RangeError) {
      const module = modules[0]!;
      return {
        ok: false,
        diagnostics: [{
          stage: "limit",
          code: "G1004",
          module: module.name,
          span: module.span,
          message: error.message,
        }],
      };
    }
    throw error;
  }
}

export function lowerGleamSource(
  name: string,
  source: string,
  exportName = "main",
): GleamFrontendResult {
  return lowerGleamSources([{ name, source }], { module: name, exportName });
}

function lowerDiagnostic(
  module: string,
  error: GleamLoweringError,
): GleamDiagnostic {
  return {
    stage: "lower",
    code: "G1002",
    module,
    span: error.span,
    message: error.message,
  };
}
