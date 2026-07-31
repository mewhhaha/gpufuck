// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Type checking a file.
//
// Checking needs the comptime evaluator, and that is not an accident of the
// implementation: a `sig` is an ordinary expression and a `const` may *be* a
// type, so the two cannot be separated. It is the same trade that removed the
// type sublanguage from the grammar.

import type { Diagnostic } from "../diagnostic.ts";
import { BlotError } from "../diagnostic.ts";
import { importExpressions, load, type Loaded } from "../load.ts";
import { childEnv, type Env as ValueEnv, type Value } from "../comptime/value.ts";
import { type Checked, checkModule, type GrantSignature, type VariantCase } from "./infer.ts";
import type { Expr, Pattern } from "../syntax/ast.ts";
import { freshVar, type SimpleType } from "./type.ts";
import { show, showModuleRow as showRow } from "./print.ts";
import { isHostEffect } from "./bridge.ts";
import { TypeError_ } from "./constrain.ts";
import { checkLinearity, type Ownership } from "../linear/check.ts";

export interface CheckResult {
  readonly type: string;
  readonly effects: string;
  /** Inferred module result retained for specialization and boundary lowering. */
  readonly moduleType: SimpleType;
  /** Inferred module row retained for the emitted ABI manifest. */
  readonly moduleEffects: SimpleType;
  readonly ownership: Ownership;
  /** What each `open` brought into scope; see `Checked`. */
  readonly opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>;
  /** Compile-time declaration values; see `Checked`. */
  readonly comptimeValues: ReadonlyMap<Expr, Value>;
  /** Field and constructor sets the backend needs; see `Checked`. */
  readonly shapes: ReadonlyMap<Expr, readonly string[]>;
  readonly variants: ReadonlyMap<Expr, readonly VariantCase[]>;
  readonly patternShapes: ReadonlyMap<Pattern, readonly string[]>;
  readonly grants: ReadonlyMap<Expr, GrantSignature>;
  /** Checked dependencies keyed by each literal import site. */
  readonly modules: ReadonlyMap<
    Expr,
    { readonly module: Loaded["module"]; readonly values: ValueEnv }
  >;
  /**
   * The module's compile-time bindings, including its own `const`s.
   *
   * Checking has to evaluate them anyway — a `const` may *be* a type — so the
   * backend reuses the results instead of running the evaluator twice.
   */
  readonly values: ValueEnv;
}

function imports(loaded: Loaded) {
  if (loaded.closure.tag !== "closure") return new Map();
  return loaded.closure.imports ?? new Map();
}

export async function checkFile(path: string): Promise<CheckResult> {
  const loaded = await load(path);
  return checkLoaded(loaded, new Map()).result;
}

interface CheckedFile {
  readonly checked: Checked;
  readonly result: CheckResult;
}

function checkLoaded(
  loaded: Loaded,
  cache: Map<string, CheckedFile>,
): CheckedFile {
  const cached = cache.get(loaded.path);
  if (cached !== undefined) return cached;

  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }

  // Nothing is seeded. The prelude is reached through `@import` like any other
  // module, so its exports arrive as a dependency's type and its facts travel
  // in `dependencyFacts` — there is no branch here that knows what a prelude
  // is.
  const values = childEnv(loaded.closure.env);

  // Each dependency is checked before its importer, so a module's exports are
  // visible as types rather than as an opaque value.
  const modules = new Map<string, SimpleType>();
  const dependencies = new Map<string, CheckedFile>();
  // A dependency's facts travel with it for the same reason the prelude's do:
  // the backend inlines an imported module, so it needs the field and
  // constructor sets inference found *inside* that module.
  const dependencyFacts: {
    opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>;
    comptimeValues: ReadonlyMap<Expr, Value>;
    shapes: ReadonlyMap<Expr, readonly string[]>;
    variants: ReadonlyMap<Expr, readonly VariantCase[]>;
    patternShapes: ReadonlyMap<Pattern, readonly string[]>;
  }[] = [];
  for (const [specifier, dependency] of loaded.dependencies) {
    const dependencyChecked = checkLoaded(dependency, cache);
    dependencies.set(specifier, dependencyChecked);
    dependencyFacts.push(dependencyChecked.checked);
    const parameter = dependency.module.parameter === null ? { tag: "unit" as const } : freshVar(0);
    modules.set(specifier, {
      tag: "fun",
      param: parameter,
      effects: dependencyChecked.checked.effects,
      result: dependencyChecked.checked.type,
    });
  }

  try {
    const checked = checkModule(
      loaded.module,
      values,
      imports(loaded),
      null,
      modules,
    );
    // A module's own row is what it performs that nothing handled. Non-empty at
    // the top level means the program would reach a `perform` with no handler
    // installed, which is exactly the runtime failure — caught statically here.
    const row = showRow(checked.effects);
    const escaping = unhandledRow(checked.effects);
    if (escaping !== "") {
      throw new BlotError(
        {
          code: "BLOT_UNHANDLED_EFFECT",
          message: `Nothing handles ${row.trim()} at the module boundary.`,
          span: loaded.module.span,
        } satisfies Diagnostic,
      );
    }
    // Ownership is checked after types. A use-after-move reported on a program
    // that does not type-check would be the second-best diagnostic.
    const linear = checkLinearity(loaded.module);
    if (linear.diagnostics.length > 0) {
      throw new BlotError(linear.diagnostics[0]);
    }
    const resolvedModules = mergeAll([
      ...[...dependencies.values()].map((dependency) => dependency.result.modules),
      new Map(
        [...importExpressions(loaded.module)].map(([site, specifier]) => {
          const dependency = dependencies.get(specifier);
          if (dependency === undefined) {
            throw new Error(
              `loaded module ${loaded.path} omitted dependency ${specifier}`,
            );
          }
          const loadedDependency = loaded.dependencies.get(specifier);
          if (loadedDependency === undefined) {
            throw new Error(
              `loaded module ${loaded.path} omitted dependency ${specifier}`,
            );
          }
          return [
            site,
            {
              module: loadedDependency.module,
              values: dependency.result.values,
            },
          ] as const;
        }),
      ),
    ]);
    const result: CheckResult = {
      type: show(checked.type),
      effects: row,
      moduleType: checked.type,
      moduleEffects: checked.effects,
      ownership: linear.ownership,
      opens: mergeAll([
        ...dependencyFacts.map((facts) => facts.opens),
        checked.opens,
      ]),
      comptimeValues: mergeAll([
        ...dependencyFacts.map((facts) => facts.comptimeValues),
        checked.comptimeValues,
      ]),
      shapes: mergeAll([
        ...dependencyFacts.map((facts) => facts.shapes),
        checked.shapes,
      ]),
      variants: mergeAll([
        ...dependencyFacts.map((facts) => facts.variants),
        checked.variants,
      ]),
      patternShapes: mergeAll([
        ...dependencyFacts.map((facts) => facts.patternShapes),
        checked.patternShapes,
      ]),
      grants: checked.grants,
      modules: resolvedModules,
      values,
    };
    const complete = { checked, result };
    cache.set(loaded.path, complete);
    return complete;
  } catch (error) {
    // The innermost module still being checked is the one its spans index into,
    // so an importer must not relabel a dependency's diagnostic as its own.
    const origin = { path: loaded.path, source: loaded.source };
    if (error instanceof TypeError_) {
      throw new BlotError(
        {
          code: "BLOT_TYPE_ERROR",
          message: `${error.detail}.`,
          span: loaded.module.span,
        } satisfies Diagnostic,
        origin,
      );
    }
    if (error instanceof BlotError && error.origin === null) {
      throw new BlotError(error.diagnostic, origin);
    }
    throw error;
  }
}

/**
 * The part of a module's row nothing accounts for.
 *
 * A host effect's operations become WebAssembly imports, so its row *is* the
 * program's declared interface and reaching the boundary is what it is for. An
 * ordinary effect there is a program that would perform with no handler
 * installed.
 */
function unhandledRow(effects: SimpleType): string {
  const labels = rowLabels(effects, new Set()).filter((label) => !isHostEffect(label));
  if (labels.length === 0) return "";
  const shown = labels.map((label) => label.replace(/#\d+$/, "")).sort();
  return `{ ${shown.join(", ")} }`;
}

function rowLabels(type: SimpleType, seen: Set<number>): string[] {
  if (type.tag === "effects") return [...type.labels];
  if (type.tag !== "var" || seen.has(type.id)) return [];
  seen.add(type.id);
  return type.lower.flatMap((bound) => rowLabels(bound, seen));
}

/** Facts from every module that contributed code; keys are node identities. */
function mergeAll<Key, Value>(
  sources: readonly (ReadonlyMap<Key, Value> | undefined)[],
): ReadonlyMap<Key, Value> {
  const merged = new Map<Key, Value>();
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [node, value] of source) merged.set(node, value);
  }
  return merged;
}

export { show };
