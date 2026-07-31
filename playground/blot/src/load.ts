// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Module loading.
//
// A module is a function from an input record to an export record. Importing
// one grants it nothing: it sees only the record its caller hands it, and the
// entry module's record is the entire authority the program has.
//
// Resolution happens before evaluation, so `@import` never touches the disk
// while a program is running and the evaluator can stay synchronous.

import type { Expr, Module } from "./syntax/ast.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { BlotError, render } from "./diagnostic.ts";
import { parse, parseLexerRecords } from "./syntax/parse.ts";
import { childEnv, type Env, type Value } from "./comptime/value.ts";
import { moduleClosure } from "./comptime/eval.ts";

export const PRELUDE = "/blot/prelude.blot";

const sources = new Map<string, string>();
const lexerRecords = new Map<string, { readonly source: string; readonly records: Int32Array }>();

export class LoadError extends Error {
  constructor(
    readonly path: string,
    readonly source: string,
    readonly diagnostics: readonly Diagnostic[],
  ) {
    super(diagnostics.map((d) => render(path, source, d)).join("\n"));
    this.name = "LoadError";
  }
}

export interface Loaded {
  readonly module: Module;
  readonly closure: Value;
  readonly dependencies: ReadonlyMap<string, Loaded>;
  readonly source: string;
  readonly path: string;
}

/** `blot:name` names a prelude module; anything else is a path. */
export function resolvePath(specifier: string, importer: string): string {
  if (specifier.startsWith("blot:")) {
    return normalizePath(`/blot/${specifier.slice("blot:".length)}.blot`);
  }
  if (specifier.startsWith("/")) return normalizePath(specifier);
  const slash = importer.lastIndexOf("/");
  const directory = slash < 0 ? "/" : importer.slice(0, slash + 1);
  return normalizePath(`${directory}${specifier}`);
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function collectImports(expr: Expr, found: Map<Expr, string>): void {
  switch (expr.tag) {
    case "apply":
      if (
        expr.fn.tag === "intrinsic" && expr.fn.name === "@import" &&
        expr.arg.tag === "text"
      ) {
        found.set(expr.arg, expr.arg.value);
      }
      collectImports(expr.fn, found);
      collectImports(expr.arg, found);
      return;
    case "field":
      collectImports(expr.target, found);
      return;
    case "lambda":
      collectImports(expr.body, found);
      return;
    case "rec":
      collectImports(expr.lambda, found);
      return;
    case "comptime":
      collectImports(expr.body, found);
      return;
    case "tuple":
      for (const element of expr.elements) collectImports(element, found);
      return;
    case "array":
      for (const element of expr.elements) collectImports(element.value, found);
      return;
    case "shape":
      for (const member of expr.members) collectImports(member.value, found);
      return;
    case "if":
      for (const branch of expr.branches) {
        collectImports(branch.condition, found);
        collectImports(branch.consequence, found);
      }
      if (expr.fallback !== null) collectImports(expr.fallback, found);
      return;
    case "case":
      collectImports(expr.target, found);
      for (const arm of expr.arms) collectImports(arm.body, found);
      return;
    case "block":
      for (const declaration of expr.declarations) {
        collectImports(declaration.value, found);
      }
      collectImports(expr.result, found);
      return;
    default:
      return;
  }
}

export function moduleImports(module: Module): readonly string[] {
  const found = importExpressions(module);
  return [...new Set(found.values())];
}

export function importExpressions(module: Module): ReadonlyMap<Expr, string> {
  const found = new Map<Expr, string>();
  for (const declaration of module.declarations) {
    collectImports(declaration.value, found);
  }
  collectImports(module.result, found);
  return found;
}

/**
 * One cache per process, not per call.
 *
 * Inference records facts for the backend keyed by AST node identity, so two
 * `load` calls returning two structurally equal trees would silently lose every
 * one of them. Sharing the cache is what keeps "the module" a single thing.
 */
const modules = new Map<string, Loaded>();

export interface ConfigureSourcesOptions {
  readonly cache?: "clear" | "reuse-unchanged";
}

export function configureSources(
  entries: Readonly<Record<string, string>>,
  options: ConfigureSourcesOptions = {},
): void {
  const nextSources = new Map(
    Object.entries(entries).map(([path, source]) => [normalizePath(path), source] as const),
  );
  if ((options.cache ?? "clear") === "clear") {
    sources.clear();
    modules.clear();
    lexerRecords.clear();
  } else {
    const changed = new Set<string>();
    for (const [path, source] of nextSources) {
      if (sources.get(path) !== source) changed.add(path);
    }
    for (const path of sources.keys()) {
      if (!nextSources.has(path)) changed.add(path);
    }
    invalidateModules(changed);
    for (const path of changed) lexerRecords.delete(path);
    sources.clear();
  }
  for (const [path, source] of nextSources) {
    sources.set(path, source);
  }
}

export function configureSourceLexerRecords(
  path: string,
  source: string,
  records: Int32Array,
): void {
  const absolute = normalizePath(path);
  const configured = sources.get(absolute);
  if (configured !== source) {
    throw new Error(
      `Blot lexer records for ${absolute} describe ${source.length} source units, but the configured source has ${
        configured?.length ?? "no"
      } units.`,
    );
  }
  lexerRecords.set(absolute, { source, records: records.slice() });
}

function invalidateModules(changedPaths: ReadonlySet<string>): void {
  const invalid = new Set(changedPaths);
  let foundDependent = true;
  while (foundDependent) {
    foundDependent = false;
    for (const [path, loaded] of modules) {
      if (invalid.has(path)) continue;
      if ([...loaded.dependencies.values()].some((dependency) => invalid.has(dependency.path))) {
        invalid.add(path);
        foundDependent = true;
      }
    }
  }
  for (const path of invalid) modules.delete(path);
}

export async function load(
  path: string,
  cache: Map<string, Loaded> = modules,
  active: readonly string[] = [],
): Promise<Loaded> {
  const absolute = normalizePath(path);
  const cached = cache.get(absolute);
  if (cached !== undefined) return cached;

  const cycleStart = active.indexOf(absolute);
  if (cycleStart >= 0) {
    const cycle = [...active.slice(cycleStart), absolute];
    throw new BlotError({
      code: "BLOT_IMPORT_CYCLE",
      message: `Import cycle: ${cycle.join(" -> ")}.`,
      span: { start: 0, end: 0 },
    });
  }
  const nextActive = [...active, absolute];

  const source = sources.get(absolute);
  if (source === undefined) {
    throw new Error(`Blot source ${absolute} is not available in this browser build.`);
  }
  const configuredLexer = lexerRecords.get(absolute);
  const parsed = configuredLexer?.source === source
    ? parseLexerRecords(source, configuredLexer.records)
    : parse(source);
  if (!parsed.ok) {
    throw new LoadError(absolute, source, parsed.diagnostics);
  }

  const imports = new Map<string, Value>();
  const dependencies = new Map<string, Loaded>();
  for (const specifier of moduleImports(parsed.module)) {
    const dependency = await load(
      resolvePath(specifier, absolute),
      cache,
      nextActive,
    );
    imports.set(specifier, dependency.closure);
    dependencies.set(specifier, dependency);
  }

  // Nothing is in scope that the module did not ask for. The prelude is an
  // ordinary module with no privilege: `open {} = (@import "blot:prelude") ();` is
  // what puts `Num.add` where the default fixity for `+` can find it, and a
  // module that does not open it does not have `+`.
  const env: Env = childEnv(null);

  const loaded: Loaded = {
    module: parsed.module,
    closure: moduleClosure(parsed.module, env, imports),
    dependencies,
    source,
    path: absolute,
  };

  cache.set(absolute, loaded);
  return loaded;
}

export { BlotError };
