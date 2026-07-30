import { type EncodedModule, UNIT_CONSTRUCTOR_NAME } from "../functional/abi.ts";
import {
  type CompilerPerformanceTrace,
  measureCompilerStage,
} from "../compiler_performance_trace.ts";
import {
  createOwnedModuleArtifact,
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

interface LowerParsedGleamModuleOptions {
  readonly trace?: CompilerPerformanceTrace;
  readonly link?: (
    modules: readonly GleamModule[],
    loweredModules: readonly LoweredGleamModule[],
    entry: { readonly module: string; readonly exportName: string },
    trace?: CompilerPerformanceTrace,
  ) => GleamFrontendResult;
}

export function lowerGleamSources(
  sources: readonly GleamSourceModule[],
  entry: { readonly module: string; readonly exportName: string },
  options: { readonly trace?: CompilerPerformanceTrace } = {},
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

  const parseAnnotations = {
    modules: sources.length,
    sourceBytes: options.trace === undefined ? 0 : sources.reduce(
      (total, source) => total + new TextEncoder().encode(source.source).byteLength,
      0,
    ),
  };
  const parsed = measureCompilerStage(options.trace, "frontend.parse", parseAnnotations, () => {
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
        } satisfies GleamFrontendResult;
      }
      names.add(source.name);
      try {
        const moduleAnnotations = {
          module: source.name,
          sourceBytes: options.trace === undefined
            ? 0
            : new TextEncoder().encode(source.source).byteLength,
          declarations: 0,
        };
        const module = options.trace === undefined
          ? parseGleamModule(source.name, source.source)
          : measureCompilerStage(
            options.trace,
            "frontend.parse.module",
            moduleAnnotations,
            () => parseGleamModule(source.name, source.source, options.trace),
            (parsedModule) => moduleAnnotations.declarations = parsedModule.declarations.length,
          );
        modules.push(module);
      } catch (error) {
        if (error instanceof GleamSyntaxError) {
          return syntaxFailure(source.name, error);
        }
        throw error;
      }
    }
    return modules;
  });
  if (!Array.isArray(parsed)) return parsed;
  return lowerParsedGleamModules(parsed, entry, lowerGleamModule, {
    ...(options.trace === undefined ? {} : { trace: options.trace }),
  });
}

export function lowerParsedGleamModules(
  modules: readonly GleamModule[],
  entry: { readonly module: string; readonly exportName: string },
  lowerModule: (
    module: GleamModule,
    signatures: readonly GleamExportSignature[],
  ) => LoweredGleamModule = lowerGleamModule,
  options: LowerParsedGleamModuleOptions = {},
): GleamFrontendResult {
  const trace = options.trace;
  const signatures: GleamExportSignature[] = [];
  const nominalAnnotations = { modules: modules.length, signatures: 0 };
  measureCompilerStage(trace, "frontend.signatures.nominal", nominalAnnotations, () => {
    for (const module of modules) {
      signatures.push(...gleamNominalExportSignatures(module));
    }
    nominalAnnotations.signatures = signatures.length;
  });
  const valueAnnotations = { modules: modules.length, signatures: 0 };
  const signatureDiagnostic = measureCompilerStage(
    trace,
    "frontend.signatures.value",
    valueAnnotations,
    () => {
      for (const module of modules) {
        try {
          signatures.push(...gleamValueExportSignatures(module, signatures));
        } catch (error) {
          if (error instanceof GleamLoweringError) {
            return { ok: false, diagnostics: [lowerDiagnostic(module.name, error)] } as const;
          }
          throw error;
        }
      }
      valueAnnotations.signatures = signatures.length;
      return null;
    },
  );
  if (signatureDiagnostic !== null) return signatureDiagnostic;

  const loweredModules: LoweredGleamModule[] = [];
  const lowerAnnotations = { modules: modules.length, signatures: signatures.length };
  const loweringDiagnostic = measureCompilerStage(
    trace,
    "frontend.lower",
    lowerAnnotations,
    () => {
      for (const module of modules) {
        try {
          const moduleAnnotations = {
            module: module.name,
            declarations: module.declarations.length,
          };
          loweredModules.push(
            trace === undefined ? lowerModule(module, signatures) : measureCompilerStage(
              trace,
              "frontend.lower.module",
              moduleAnnotations,
              () => lowerModule(module, signatures),
            ),
          );
        } catch (error) {
          if (error instanceof GleamLoweringError) {
            return { ok: false, diagnostics: [lowerDiagnostic(module.name, error)] } as const;
          }
          throw error;
        }
      }
      return null;
    },
  );
  if (loweringDiagnostic !== null) return loweringDiagnostic;

  return (options.link ?? linkLoweredGleamModules)(modules, loweredModules, entry, trace);
}

export function linkLoweredGleamModules(
  modules: readonly GleamModule[],
  loweredModules: readonly LoweredGleamModule[],
  entry: { readonly module: string; readonly exportName: string },
  trace?: CompilerPerformanceTrace,
): GleamFrontendResult {
  try {
    const entryModule = modules.find((module) => module.name === entry.module);
    const entryDeclaration = entryModule?.declarations.find((declaration) =>
      declaration.public && declaration.name === entry.exportName
    );
    const invokesZeroArgumentFunction = entryDeclaration?.kind === "function" &&
      entryDeclaration.parameters.length === 0;
    const entryArtifact = invokesZeroArgumentFunction
      ? createOwnedModuleArtifact({
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
    const artifacts = [
      gleamPreludeArtifact(),
      ...loweredModules.map((lowered) => lowered.artifact),
      ...(entryArtifact === null ? [] : [entryArtifact]),
    ];
    const linkAnnotations = { modules: artifacts.length, nodes: 0, definitions: 0, types: 0 };
    const linked = measureCompilerStage(
      trace,
      "frontend.link",
      linkAnnotations,
      () =>
        linkModules(
          artifacts,
          entryArtifact === null ? entry : { module: entryArtifact.name, exportName: "main" },
          trace === undefined ? {} : { trace },
        ),
      (result) => {
        linkAnnotations.nodes = result.module.nodeCount;
        linkAnnotations.definitions = result.module.definitionCount;
        linkAnnotations.types = result.module.typeCount;
      },
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

function syntaxFailure(
  module: string,
  error: GleamSyntaxError,
): Extract<GleamFrontendResult, { readonly ok: false }> {
  return {
    ok: false,
    diagnostics: [{
      stage: "parse",
      code: "G1001",
      module,
      span: error.span,
      message: error.message,
    }],
  };
}
