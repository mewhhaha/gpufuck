// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// blot AST -> gpufuck Functional Surface.
//
// gpufuck re-runs Hindley-Milner on whatever it is handed, so blot's
// algebraic-subtyping result is the authority and what reaches here has to be
// specialized enough for HM to re-check. A gpufuck inference failure on a
// well-typed blot program is a lowering bug, never a type-system disagreement
// to paper over.
//
// Three structural gaps between the languages, and how each is closed:
//
//   * **Records and tuples are not Core primitives.** gpufuck lowers them to
//     nominal declarations, so one nominal type is synthesized per distinct
//     field-name set. A tuple is a shape with integer labels, so it needs no
//     second mechanism.
//   * **`if` wants a boolean.** blot's conditions are `#True | #False`, ordinary
//     prelude constructors, so those two tags become gpufuck booleans.
//   * **Application is unary in both languages.** That one costs nothing, which
//     is exactly why blot's single-parameter rule was worth keeping.

import {
  BinaryOperator,
  defineEffectOperation,
  effectSet,
  type HostCapabilityDeclaration,
  type HostDefinitionBinding,
  HostTypes,
  NumericConversion,
  storeType,
  surface,
  type SurfaceDefinition,
  type SurfaceExpression,
  type SurfaceTypeDeclaration,
  type TypeSchema,
  UNIT_CONSTRUCTOR_NAME,
  WasmIntrinsic,
} from "../../../../functional.ts";
import type {
  ArrayElement,
  Decl,
  Expr,
  Module,
  Pattern,
  ShapeMember,
  Span,
} from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import type { GrantSignature, VariantCase } from "../check/infer.ts";
import type { SimpleType } from "../check/type.ts";
import {
  childEnv,
  type Env as ValueEnv,
  lookup as lookupValue,
  type Value,
} from "../comptime/value.ts";

/**
 * What inference recorded for the backend: the whole field set behind a
 * projection, and the whole constructor set behind a `case`. Neither is
 * recoverable from the syntax, and re-deriving them here would mean a second
 * type checker.
 */
export interface Facts {
  /** What each `open` brought into scope, so an inlined module keeps its own. */
  readonly opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>;
  /** Compile-time declaration values that remain inside residual blocks. */
  readonly comptimeValues: ReadonlyMap<Expr, Value>;
  readonly shapes: ReadonlyMap<Expr, readonly string[]>;
  readonly variants: ReadonlyMap<Expr, readonly VariantCase[]>;
  /** Dependencies keyed by literal import site, so relative paths never alias. */
  readonly modules: ReadonlyMap<
    Expr,
    { readonly module: Module; readonly values: ValueEnv }
  >;
  /** The field set of the value a shape pattern destructures. */
  readonly patternShapes: ReadonlyMap<Pattern, readonly string[]>;
  /** Signatures of the capabilities granted through the module parameter. */
  readonly grants: ReadonlyMap<Expr, GrantSignature>;
}

/** Every union of constructors bound to a compile-time name, in scope order. */
function declaredUnions(values: ValueEnv): (readonly VariantCase[])[] {
  const found: (readonly VariantCase[])[] = [];
  let scope: ValueEnv | null = values;
  while (scope !== null) {
    for (const value of scope.names.values()) {
      if (value.tag !== "union") continue;
      const cases: VariantCase[] = [];
      let allTags = true;
      for (const member of value.members) {
        if (member.tag !== "tag") {
          allTags = false;
          break;
        }
        cases.push({ name: member.name, payload: member.payload !== null });
      }
      if (allTags && cases.length > 0) found.push(cases);
    }
    scope = scope.parent;
  }
  return found;
}

/** A nominal type standing in for one shape of record. */
interface Nominal {
  readonly name: string;
  readonly fields: readonly string[];
}

/** A nominal type standing in for one set of constructors. */
interface Sum {
  readonly name: string;
  readonly cases: readonly VariantCase[];
}

interface Sealed {
  readonly name: string;
  readonly constructor: string;
  readonly sourceName: string;
}

/** Constructors share one namespace in Core, so they are qualified by their type. */
function constructorName(sum: Sum, tag: string): string {
  return `${sum.name}_${tag}`;
}

export interface Lowered {
  readonly definitions: readonly SurfaceDefinition[];
  readonly types: readonly SurfaceTypeDeclaration[];
  readonly entry: string;
  /** Host-implemented effects, as capabilities the module imports. */
  readonly capabilities: readonly HostCapabilityDeclaration[];
  readonly hostDefinitions: readonly HostDefinitionBinding[];
  /**
   * Field names per synthesized nominal, so a caller can read a record back.
   * The boundary hands out a constructor; without this the field names are a
   * lowering detail nobody outside can recover.
   */
  readonly shapes: ReadonlyMap<string, readonly string[]>;
  /** Source spellings for variant and sealed constructors at the ABI. */
  readonly constructors: ReadonlyMap<string, RuntimeConstructor>;
  /** Structural declarations needed to publish the stable caller ABI. */
  readonly runtimeTypes: ReadonlyMap<string, RuntimeTypeDeclaration>;
  readonly exports: readonly LoweredExport[];
}

export type RuntimeTypeDeclaration =
  | {
    readonly kind: "record";
    readonly fields: readonly string[];
  }
  | {
    readonly kind: "variant";
    readonly cases: readonly {
      readonly sourceName: string;
      readonly runtimeName: string;
      readonly payload: boolean;
    }[];
  }
  | {
    readonly kind: "sealed";
    readonly sourceName: string;
    readonly runtimeName: string;
  };

export interface RuntimeConstructor {
  readonly kind: "variant" | "sealed";
  readonly sourceName: string;
  readonly payload: boolean;
}

const ENTRY = "main";
const MODULE_RESULT = "blot$module$result";

export interface RuntimeExport {
  readonly sourceName: string;
  readonly type: SimpleType;
  readonly value?: Value;
}

export interface LoweredExport {
  readonly sourceName: string;
  readonly wasmName: string;
  readonly definition: string;
  readonly type: TypeSchema;
}

class Lowering {
  readonly nominals = new Map<string, Nominal>();
  readonly sums = new Map<string, Sum>();
  readonly seals = new Map<string, Sealed>();
  readonly definitions: SurfaceDefinition[] = [];
  /** Hoisted prelude closures, by identity: one definition per closure. */
  readonly hoisted = new Map<Value, string>();
  /** One capability per host effect, and one definition per operation. */
  readonly capabilities = new Map<string, HostCapabilityDeclaration>();
  readonly hostDefinitions: HostDefinitionBinding[] = [];
  readonly hostOperations = new Map<string, string>();
  /** Which effect owns each capability name; see `hostOperation`. */
  readonly capabilityOwners = new Map<string, number>();
  /** Blot effect operations, as Core evidence a handler can replace. */
  readonly effectOperations = new Map<string, string>();
  private next = 0;

  /**
   * Constructor sets declared as compile-time unions.
   *
   * `const Message = #Ready | #Progress Int` *is* a constructor set, and it is
   * often the only place the whole set appears — a `case` with a wildcard arm
   * names one tag and inference has nothing else to read. Harvesting the
   * declarations is what makes that recoverable without duplicating a
   * definition per instantiation.
   */
  readonly declared: readonly (readonly VariantCase[])[];

  constructor(readonly facts: Facts, values: ValueEnv) {
    this.declared = declaredUnions(values);
  }

  /**
   * One nominal per distinct constructor set, and every tag carries a payload
   * slot. blot's `#Ready` has none and `#Progress n` has one; giving both a
   * field and passing unit for the empty case keeps the two forms one shape,
   * which is cheaper than two constructor kinds in Core.
   */
  sum(cases: readonly VariantCase[]): Sum {
    const sorted = [...cases].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    const key = sorted.map((entry) => {
      let arity = "0";
      if (entry.payload) arity = "1";
      return `${entry.name}:${arity}`;
    }).join(" ");
    const existing = this.sums.get(key);
    if (existing !== undefined) return existing;
    const sum: Sum = {
      name: `Sum${this.sums.size}`,
      cases: sorted,
    };
    this.sums.set(key, sum);
    return sum;
  }

  seal(sourceName: string): Sealed {
    const existing = this.seals.get(sourceName);
    if (existing !== undefined) return existing;
    const sealed = {
      name: `Sealed${this.seals.size}`,
      constructor: `Sealed${this.seals.size}`,
      sourceName,
    };
    this.seals.set(sourceName, sealed);
    return sealed;
  }

  /**
   * The constructor set a tag belongs to.
   *
   * Inference records the whole set at each `case`, which is where it is
   * knowable; a construction site only knows its own tag. Matching the tag
   * against the recorded sets recovers the rest. An ambiguous tag — one that
   * two different variants both use — is refused rather than guessed.
   */
  sumFor(tag: string, payload: boolean, span: Span): Sum {
    const candidates = new Map<string, readonly VariantCase[]>();
    for (const cases of [...this.facts.variants.values(), ...this.declared]) {
      if (!cases.some((entry) => entry.name === tag)) continue;
      const key = cases.map((entry) => entry.name).sort().join(" ");
      candidates.set(key, cases);
    }
    if (candidates.size === 0) return this.sum([{ name: tag, payload }]);
    if (candidates.size > 1) {
      fail(
        "BLOT_UNSUPPORTED_LOWERING",
        `\`#${tag}\` belongs to more than one union in this module, and lowering cannot tell which one is meant here.`,
        span,
      );
    }
    return this.sum([...candidates.values()][0]);
  }

  fresh(hint: string): string {
    this.next += 1;
    return `${hint}$${this.next}`;
  }

  /**
   * One nominal per distinct field-name set. Two records with the same labels
   * are the same type to gpufuck, which is what makes blot's structural shapes
   * survive a nominal Core.
   */
  nominal(fields: readonly string[]): Nominal {
    // Keyed by the canonical order, because two records with the same *labels*
    // are the same type however they were written. A field set is recorded in
    // the order the program first projected it, so `pair.1` before `pair.0`
    // yields `["1", "0"]` where a tuple literal yields `["0", "1"]` — the same
    // type, and keying on the written order declared both as `Tuple2`.
    const ordered = [...fields].sort((left, right) => {
      const both = /^\d+$/.test(left) && /^\d+$/.test(right);
      if (both) return Number(left) - Number(right);
      if (left < right) return -1;
      return left > right ? 1 : 0;
    });
    const key = ordered.join("\u0000");
    const existing = this.nominals.get(key);
    if (existing !== undefined) return existing;
    let label = `Shape${this.nominals.size}`;
    if (ordered.length === 0) {
      label = "Empty";
    } else if (ordered.every((name) => /^\d+$/.test(name))) {
      label = `Tuple${ordered.length}`;
    }
    // The key is canonical so both orderings find one nominal; construction
    // and projection preserve the source order that established the shape.
    const nominal: Nominal = { name: label, fields };
    this.nominals.set(key, nominal);
    return nominal;
  }

  declarations(): SurfaceTypeDeclaration[] {
    const sums: SurfaceTypeDeclaration[] = [...this.sums.values()].map((
      sum,
    ) => {
      const payloads = sum.cases.filter((entry) => entry.payload);
      return {
        name: sum.name,
        parameters: payloads.map((_, index) => `p${index}`),
        constructors: sum.cases.map((entry) => {
          if (!entry.payload) {
            return {
              name: constructorName(sum, entry.name),
              fields: [],
            };
          }
          const index = payloads.indexOf(entry);
          return {
            name: constructorName(sum, entry.name),
            fields: [{
              name: "payload",
              type: {
                kind: "parameter",
                name: `p${index}`,
              } satisfies TypeSchema,
            }],
          };
        }),
      };
    });
    return [
      ...sums,
      ...[...this.seals.values()].map((sealed) => ({
        name: sealed.name,
        parameters: ["value"],
        constructors: [{
          name: sealed.constructor,
          fields: [{
            name: "value",
            type: { kind: "parameter", name: "value" } satisfies TypeSchema,
          }],
        }],
      })),
      ...[...this.nominals.values()].map((nominal) => ({
        name: nominal.name,
        // Polymorphic in every field: gpufuck's HM decides what each one holds,
        // so the nominal carries structure without committing to content.
        parameters: nominal.fields.map((_, index) => `t${index}`),
        constructors: [{
          name: nominal.name,
          fields: nominal.fields.map((name, index) => ({
            name: `f${index}_${name}`,
            type: { kind: "parameter", name: `t${index}` } satisfies TypeSchema,
          })),
        }],
      })),
    ];
  }
}

interface Scope {
  readonly names: Map<string, string>;
  /**
   * Bindings whose value is a shape written right there.
   *
   * A handler and the computation it wraps both have to be statically known to
   * be specialized, and binding one to a name does not make it less known —
   * `lowerHandle` needs their syntax, not the closures the evaluator would
   * build, so the expression is what is remembered.
   */
  readonly literals: Map<string, Expr>;
  readonly parent: Scope | null;
  /**
   * The compile-time bindings visible here — the prelude, and whatever a
   * closure captured. A name that is not a local is looked up here and
   * specialized, which is how `+` reaches Wasm at all: `Num.add` is a prelude
   * closure, not a primitive, and nothing would resolve it otherwise.
   */
  readonly values: ValueEnv;
  /** The module parameter's name, whose fields are granted capabilities. */
  granted?: string;
  /**
   * The compile-time value being hoisted into a top-level definition, when
   * this scope is inside one.
   *
   * A hoisted definition has no enclosing frame, so a name it fails to resolve
   * is not an unbound name — the checker already proved every name is bound.
   * It is a `const` reaching for a binding that only exists at run time.
   */
  hoisting?: string;
}

function childScope(parent: Scope | null, values?: ValueEnv): Scope {
  const visibleValues = values === undefined ? childEnv(parent!.values) : childEnv(values);
  return {
    names: new Map(),
    literals: new Map(),
    parent,
    values: visibleValues,
    granted: parent?.granted,
    hoisting: parent?.hoisting,
  };
}

/** A value that exists only while compiling: a type, a union, an effect. */
function compileTimeOnly(value: Value | undefined): boolean {
  if (value === undefined) return false;
  // `extended` is a type carrying a namespace — what `struct` returns. Its
  // members are constructors and accessors that have already been applied by
  // the time anything reaches here, so the binding itself never runs.
  return value.tag === "effect" || value.tag === "range" ||
    value.tag === "union" || value.tag === "arrow" ||
    value.tag === "unbounded" || value.tag === "extended";
}

function resolveLiteral(scope: Scope, name: string): Expr | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const found = current.literals.get(name);
    if (found !== undefined) return found;
    current = current.parent;
  }
  return null;
}

function resolve(scope: Scope, name: string): string | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const found = current.names.get(name);
    if (found !== undefined) return found;
    current = current.parent;
  }
  return null;
}

/** Primitives with a direct Core operator. Everything else is unsupported. */
const BINARY: ReadonlyMap<string, BinaryOperator> = new Map([
  ["@int.add", BinaryOperator.AddSignedInteger64],
  ["@int.sub", BinaryOperator.SubtractSignedInteger64],
  ["@int.mul", BinaryOperator.MultiplySignedInteger64],
  ["@int.div", BinaryOperator.DivideSignedInteger64],
  ["@int.rem", BinaryOperator.RemainderSignedInteger64],
]);

export function lowerModule(
  module: Module,
  facts: Facts,
  values: ValueEnv,
  runtimeExports: readonly RuntimeExport[] = [],
): Lowered {
  const lowering = new Lowering(facts, values);
  const scope = childScope(null, values);

  // The entry module's parameter is the program's whole authority, and at this
  // boundary that authority *is* the module's imports. It has no runtime
  // representation of its own: each field the program reaches for becomes a
  // declared host operation, so nothing is passed in and nothing is ambient.
  if (module.parameter !== null && module.parameter.tag === "name") {
    scope.granted = module.parameter.name;
  } else if (module.parameter !== null) {
    fail(
      "BLOT_UNSUPPORTED_LOWERING",
      "A module parameter must be a single name to be granted as capabilities.",
      module.span,
    );
  }

  const body = lowerBlock(module.declarations, module.result, scope, lowering);
  lowering.definitions.push({
    name: MODULE_RESULT,
    parameters: [],
    annotation: null,
    body,
  });
  const exports = lowerExports(
    module.result,
    runtimeExports,
    lowering,
  );
  if (exports.some((exported) => exported.type.kind === "function")) {
    const initialized = lowering.fresh("module");
    lowering.definitions.push({
      name: ENTRY,
      parameters: [],
      annotation: { kind: "unit" },
      body: surface.let(
        initialized,
        surface.name(MODULE_RESULT),
        surface.name(UNIT_CONSTRUCTOR_NAME),
      ),
    });
  } else {
    lowering.definitions.push({
      name: ENTRY,
      parameters: [],
      annotation: null,
      body: surface.name(MODULE_RESULT),
    });
  }

  return {
    definitions: lowering.definitions,
    types: lowering.declarations(),
    entry: ENTRY,
    capabilities: [...lowering.capabilities.values()],
    hostDefinitions: lowering.hostDefinitions,
    exports,
    shapes: new Map(
      [...lowering.nominals.values()].map((nominal) => [nominal.name, nominal.fields] as const),
    ),
    constructors: new Map<string, RuntimeConstructor>([
      ...[...lowering.sums.values()].flatMap((sum) =>
        sum.cases.map((entry) =>
          [
            constructorName(sum, entry.name),
            {
              kind: "variant",
              sourceName: entry.name,
              payload: entry.payload,
            },
          ] as const
        )
      ),
      ...[...lowering.seals.values()].map((sealed) =>
        [
          sealed.constructor,
          {
            kind: "sealed",
            sourceName: sealed.sourceName,
            payload: true,
          },
        ] as const
      ),
    ]),
    runtimeTypes: new Map<string, RuntimeTypeDeclaration>([
      ...[...lowering.nominals.values()].map((nominal) =>
        [
          nominal.name,
          { kind: "record", fields: nominal.fields },
        ] as const
      ),
      ...[...lowering.sums.values()].map((sum) =>
        [
          sum.name,
          {
            kind: "variant",
            cases: sum.cases.map((case_) => ({
              sourceName: case_.name,
              runtimeName: constructorName(sum, case_.name),
              payload: case_.payload,
            })),
          },
        ] as const
      ),
      ...[...lowering.seals.values()].map((sealed) =>
        [
          sealed.name,
          {
            kind: "sealed",
            sourceName: sealed.sourceName,
            runtimeName: sealed.constructor,
          },
        ] as const
      ),
    ]),
  };
}

function lowerExports(
  result: Expr,
  exports: readonly RuntimeExport[],
  lowering: Lowering,
): LoweredExport[] {
  if (exports.length === 0) return [];
  const [first] = exports;
  if (exports.length === 1 && first.sourceName === "default") {
    return [lowerExport(
      first,
      surface.name(MODULE_RESULT),
      0,
      result.span,
      lowering,
    )];
  }
  let shape: (Expr & { readonly tag: "shape" }) | null = null;
  if (result.tag === "shape") shape = result;
  if (result.tag === "block" && result.result.tag === "shape") {
    shape = result.result;
  }
  if (shape === null) {
    throw new Error("named exports require a record module result");
  }

  const nominal = lowering.nominal(
    exports.map((exported) => exported.sourceName),
  );
  const binders = nominal.fields.map((field) => lowering.fresh(field));
  return exports.map((exported, index) => {
    const field = nominal.fields.indexOf(exported.sourceName);
    if (field < 0) {
      throw new Error(
        `module result omitted runtime export ${exported.sourceName}`,
      );
    }
    const body = surface.case(surface.name(MODULE_RESULT), [{
      constructor: nominal.name,
      binders,
      body: surface.name(binders[field]),
    }]);
    return lowerExport(exported, body, index, result.span, lowering);
  });
}

function lowerExport(
  exported: RuntimeExport,
  body: SurfaceExpression,
  index: number,
  span: Span,
  lowering: Lowering,
): LoweredExport {
  const definition = `blot$export$${index}`;
  const wasmName = `blot:${exported.sourceName}`;
  let type: TypeSchema;
  if (exported.value !== undefined && exported.value.tag === "sealed") {
    type = valueExportSchema(
      exported.value,
      exported.sourceName,
      span,
      lowering,
    );
  } else {
    type = exportSchema(exported.type, exported.sourceName, span, lowering);
  }
  lowering.definitions.push({
    name: definition,
    parameters: [],
    annotation: type,
    body,
  });
  return {
    sourceName: exported.sourceName,
    wasmName,
    definition,
    type,
  };
}

function exportSchema(
  type: SimpleType,
  name: string,
  span: Span,
  lowering: Lowering,
  seen = new Set<number>(),
): TypeSchema {
  switch (type.tag) {
    case "unit":
      return { kind: "unit" };
    case "range":
      if (type.domain === "int") return { kind: "signed-integer-64" };
      return HostTypes.text;
    case "fun":
      return {
        kind: "function",
        parameter: exportSchema(type.param, name, span, lowering, seen),
        result: exportSchema(type.result, name, span, lowering, seen),
      };
    case "record": {
      const nominal = lowering.nominal([...type.fields.keys()]);
      return {
        kind: "named",
        name: nominal.name,
        arguments: nominal.fields.map((field) => {
          const fieldType = type.fields.get(field);
          if (fieldType === undefined) {
            throw new Error(
              `inferred record for export ${name} omitted field ${field}`,
            );
          }
          return exportSchema(fieldType, name, span, lowering, seen);
        }),
      };
    }
    case "array":
      return storeType(exportSchema(type.element, name, span, lowering, seen));
    case "variant": {
      const names = [...type.cases.keys()];
      if (
        names.length > 0 &&
        names.every((constructor) => constructor === "True" || constructor === "False")
      ) {
        return { kind: "boolean" };
      }
      const cases = names.map((constructor) => {
        const payload = type.cases.get(constructor);
        if (payload === undefined) {
          throw new Error(
            `inferred variant for export ${name} omitted ${constructor}`,
          );
        }
        return { name: constructor, payload: payload.tag !== "unit" };
      });
      const sum = lowering.sum(cases);
      return {
        kind: "named",
        name: sum.name,
        arguments: sum.cases.flatMap((constructor) => {
          if (!constructor.payload) return [];
          const payload = type.cases.get(constructor.name);
          if (payload === undefined) {
            throw new Error(
              `inferred variant for export ${name} omitted ${constructor.name}`,
            );
          }
          return [exportSchema(payload, name, span, lowering, seen)];
        }),
      };
    }
    case "var": {
      if (seen.has(type.id)) return unsupportedExport(name, span);
      seen.add(type.id);
      let bounds = type.lower;
      if (bounds.length === 0) bounds = type.upper;
      if (bounds.length === 0) return unsupportedExport(name, span);
      if (bounds.every((bound) => bound.tag === "range")) {
        const ranges = bounds as (SimpleType & { readonly tag: "range" })[];
        const domain = ranges[0].domain;
        if (ranges.every((range) => range.domain === domain)) {
          if (domain === "int") return { kind: "signed-integer-64" };
          return HostTypes.text;
        }
      }
      // An open bound names the constructors one `case` read rather than the
      // whole union, and an export needs the whole one.
      if (bounds.every((bound) => bound.tag === "variant" && !bound.open)) {
        const cases = new Map<string, SimpleType>();
        for (const bound of bounds) {
          if (bound.tag !== "variant") {
            throw new Error("variant bounds changed while lowering an export");
          }
          for (const [constructor, payload] of bound.cases) {
            cases.set(constructor, payload);
          }
        }
        return exportSchema(
          { tag: "variant", cases, open: false },
          name,
          span,
          lowering,
          new Set(seen),
        );
      }
      const schemas = bounds.map((bound) =>
        exportSchema(bound, name, span, lowering, new Set(seen))
      );
      const [first] = schemas;
      const key = JSON.stringify(first);
      if (schemas.some((schema) => JSON.stringify(schema) !== key)) {
        return unsupportedExport(name, span);
      }
      return first;
    }
    case "union": {
      const schemas = type.members.map((member) =>
        exportSchema(member, name, span, lowering, new Set(seen))
      );
      const [first] = schemas;
      if (first === undefined) return unsupportedExport(name, span);
      const key = JSON.stringify(first);
      if (schemas.some((schema) => JSON.stringify(schema) !== key)) {
        return unsupportedExport(name, span);
      }
      return first;
    }
    default:
      return unsupportedExport(name, span);
  }
}

function valueExportSchema(
  value: Value,
  name: string,
  span: Span,
  lowering: Lowering,
): TypeSchema {
  if (value.tag === "sealed") {
    const sealed = lowering.seal(value.name);
    return {
      kind: "named",
      name: sealed.name,
      arguments: [valueExportSchema(value.inner, name, span, lowering)],
    };
  }
  const bridged = bridgeRuntimeValue(value);
  if (bridged === null) return unsupportedExport(name, span);
  return exportSchema(bridged, name, span, lowering);
}

function bridgeRuntimeValue(value: Value): SimpleType | null {
  switch (value.tag) {
    case "int":
      return {
        tag: "range",
        domain: "int",
        low: value.value,
        high: value.value,
      };
    case "text":
      return {
        tag: "range",
        domain: "text",
        low: value.value,
        high: value.value,
      };
    case "unit":
      return { tag: "unit" };
    case "array": {
      const elements: SimpleType[] = [];
      for (const element of value.elements) {
        const type = bridgeRuntimeValue(element);
        if (type === null) return null;
        elements.push(type);
      }
      return { tag: "array", element: { tag: "union", members: elements } };
    }
    case "shape": {
      const fields = new Map<string, SimpleType>();
      for (const [field, member] of value.fields) {
        const type = bridgeRuntimeValue(member);
        if (type === null) return null;
        fields.set(field, type);
      }
      return { tag: "record", fields };
    }
    case "tag": {
      let payload: SimpleType = { tag: "unit" };
      if (value.payload !== null) {
        const bridged = bridgeRuntimeValue(value.payload);
        if (bridged === null) return null;
        payload = bridged;
      }
      return {
        tag: "variant",
        cases: new Map([[value.name, payload]]),
        open: false,
      };
    }
    default:
      return null;
  }
}

function unsupportedExport(name: string, span: Span): never {
  return fail(
    "BLOT_EXPORT_NOT_FIRST_ORDER",
    `Export \`${name}\` does not have a concrete first-order WebAssembly type.`,
    span,
  );
}

/**
 * A host effect's operation, as the definition that calls it.
 *
 * gpufuck's capabilities are exactly blot's host effects: a named record of
 * operations, each with a parameter type, a result type, and the effect it
 * performs. Declaring one turns it into a typed WebAssembly import, so blot
 * needs no raw import form — you declare an effect, and the boundary follows.
 */
function hostOperation(
  effect: Value & { tag: "effect" },
  operation: string,
  lowering: Lowering,
  span: Span,
): string {
  const key = `${effect.name}#${effect.id}.${operation}`;
  const existing = lowering.hostOperations.get(key);
  if (existing !== undefined) return existing;

  const signature = effect.operations.get(operation);
  if (signature === undefined || signature.tag !== "arrow") {
    fail(
      "BLOT_UNSUPPORTED_LOWERING",
      `\`${effect.name}.${operation}\` has no operation type to import against.`,
      span,
    );
  }
  const parameter = boundaryType(signature.domain, span, lowering);
  const result = boundaryType(signature.codomain, span, lowering);
  // Named by identity, not by spelling. The memo that stops this being minted
  // twice is keyed on the effect's id, and a name that is less unique than its
  // memo is a duplicate definition waiting for two effects to share a name.
  const name = `${effect.name}$${effect.id}$${operation}`;

  lowering.hostOperations.set(key, name);
  lowering.definitions.push({
    name,
    parameters: [],
    annotation: { kind: "function", parameter, result },
    // Never executed: the binding below replaces the body with the import.
    body: surface.runtimeFault(`host operation ${effect.name}.${operation}`),
  });

  const capability = lowering.capabilities.get(effect.name);
  // Unlike a definition name, a capability name *is* the host-facing contract —
  // the host supplies `init.Console` by that name — so it cannot be made unique
  // behind the programmer's back. Two distinct host effects claiming it are
  // ambiguous at the boundary, and merging their operations would be worse than
  // saying so.
  if (
    capability !== undefined &&
    lowering.capabilityOwners.get(effect.name) !== effect.id
  ) {
    fail(
      "BLOT_AMBIGUOUS_CAPABILITY",
      `Two different host effects are both named \`${effect.name}\`, so the host cannot tell which one it is implementing.`,
      span,
    );
  }
  lowering.capabilityOwners.set(effect.name, effect.id);
  const field = {
    kind: "operation" as const,
    name: operation,
    effects: effectSet(effect.name),
    parameter,
    result,
  };
  if (capability === undefined) {
    lowering.capabilities.set(effect.name, {
      name: effect.name,
      fields: [field],
    });
  } else {
    lowering.capabilities.set(effect.name, {
      name: effect.name,
      fields: [...capability.fields, field],
    });
  }
  lowering.hostDefinitions.push({
    definition: name,
    capability: effect.name,
    field: operation,
  });
  return name;
}

/**
 * A blot effect's operation, as Core evidence.
 *
 * gpufuck carries an effect label on a definition and lets a handler *replace*
 * the operation lexically; a pure replacement discharges the label. So an
 * operation is an ordinary definition whose body traps — unhandled is exactly
 * what a trap means — and handling it is substituting a real implementation.
 */
function effectOperation(
  effect: Value & { tag: "effect" },
  operation: string,
  lowering: Lowering,
  span: Span,
): string {
  const key = `${effect.name}#${effect.id}.${operation}`;
  const existing = lowering.effectOperations.get(key);
  if (existing !== undefined) return existing;

  const signature = effect.operations.get(operation);
  if (signature === undefined || signature.tag !== "arrow") {
    fail(
      "BLOT_UNSUPPORTED_LOWERING",
      `\`${effect.name}.${operation}\` has no operation type.`,
      span,
    );
  }
  const name = `${effect.name}$${effect.id}$${operation}`;

  lowering.effectOperations.set(key, name);
  lowering.definitions.push(defineEffectOperation({
    name,
    parameter: {
      name: "argument",
      type: boundaryType(signature.domain, span, lowering),
    },
    result: boundaryType(signature.codomain, span, lowering),
    effects: effectSet(`${effect.name}.${operation}`),
    // Performing with nothing to handle it is a trap, which is what the
    // checker already refuses statically. This is the residue of that rule.
    body: surface.runtimeFault(`unhandled effect ${effect.name}.${operation}`),
  }));
  return name;
}

function grantedName(scope: Scope): string | undefined {
  let current: Scope | null = scope;
  while (current !== null) {
    if (current.granted !== undefined) return current.granted;
    current = current.parent;
  }
  return undefined;
}

/**
 * An inferred type, as a boundary type.
 *
 * Distinct from `boundaryType`, which reads a compile-time *value*: a granted
 * capability's signature comes from inference, not from a written type, so the
 * lattice is what has to be read here.
 */
function schemaOf(
  type: SimpleType,
  operation: string,
  span: Span,
  lowering: Lowering,
  unconstrained: TypeSchema | null = null,
  seen = new Set<number>(),
): TypeSchema {
  if (type.tag === "unit") return { kind: "unit" };
  if (type.tag === "range") {
    if (type.domain === "int") return { kind: "signed-integer-64" };
    return HostTypes.text;
  }
  if (type.tag === "variant") {
    const names = [...type.cases.keys()].sort();
    if (names.length > 0 && names.every((n) => n === "True" || n === "False")) {
      return { kind: "boolean" };
    }
    return exportSchema(type, operation, span, lowering);
  }
  if (type.tag === "record" || type.tag === "array") {
    return exportSchema(type, operation, span, lowering);
  }
  if (type.tag === "var" && !seen.has(type.id)) {
    seen.add(type.id);
    for (const bound of [...type.lower, ...type.upper]) {
      try {
        return schemaOf(
          bound,
          operation,
          span,
          lowering,
          unconstrained,
          seen,
        );
      } catch {
        continue;
      }
    }
    // A result nothing observes has no constraints to read, and `()` is what
    // "nothing observes it" means at the boundary. Only the result position
    // passes a fallback: an unconstrained *parameter* would mean the host
    // cannot know what it is being handed.
    if (unconstrained !== null) return unconstrained;
  }
  fail(
    "BLOT_UNSUPPORTED_LOWERING",
    `The granted capability \`${operation}\` takes or returns something that cannot cross the host boundary — only integers, text, booleans, and \`()\` can.`,
    span,
  );
}

/** The capability a module parameter's field names. */
const GRANT_CAPABILITY = "Init";

function grantOperation(
  operation: string,
  signature: GrantSignature,
  lowering: Lowering,
  span: Span,
): string {
  const key = `${GRANT_CAPABILITY}.${operation}`;
  const existing = lowering.hostOperations.get(key);
  if (existing !== undefined) return existing;

  const parameter = schemaOf(signature.parameter, operation, span, lowering);
  const result = schemaOf(
    signature.result,
    operation,
    span,
    lowering,
    { kind: "unit" },
  );
  const name = `${GRANT_CAPABILITY}$${operation}`;
  lowering.hostOperations.set(key, name);
  lowering.definitions.push({
    name,
    parameters: [],
    annotation: { kind: "function", parameter, result },
    body: surface.runtimeFault(`host operation ${key}`),
  });

  const capability = lowering.capabilities.get(GRANT_CAPABILITY);
  const field = {
    kind: "operation" as const,
    name: operation,
    effects: effectSet(GRANT_CAPABILITY),
    parameter,
    result,
  };
  lowering.capabilities.set(GRANT_CAPABILITY, {
    name: GRANT_CAPABILITY,
    fields: capability === undefined ? [field] : [...capability.fields, field],
  });
  lowering.capabilityOwners.set(GRANT_CAPABILITY, -1);
  lowering.hostDefinitions.push({
    definition: name,
    capability: GRANT_CAPABILITY,
    field: operation,
  });
  return name;
}

/** The capability blot declares for text it cannot inspect in Core. */
const TEXT_CAPABILITY = "Text";

function textOperation(
  operation: string,
  parameter: TypeSchema,
  result: TypeSchema,
  lowering: Lowering,
): string {
  const key = `${TEXT_CAPABILITY}.${operation}`;
  const existing = lowering.hostOperations.get(key);
  if (existing !== undefined) return existing;

  const name = `${TEXT_CAPABILITY}$${operation}`;
  lowering.hostOperations.set(key, name);
  lowering.definitions.push({
    name,
    parameters: [],
    annotation: { kind: "function", parameter, result },
    body: surface.runtimeFault(`host operation ${key}`),
  });

  const capability = lowering.capabilities.get(TEXT_CAPABILITY);
  const field = {
    kind: "operation" as const,
    name: operation,
    effects: effectSet(),
    parameter,
    result,
    wasmIntrinsic: textIntrinsic(operation),
  };
  lowering.capabilities.set(TEXT_CAPABILITY, {
    name: TEXT_CAPABILITY,
    fields: capability === undefined ? [field] : [...capability.fields, field],
  });
  lowering.capabilityOwners.set(TEXT_CAPABILITY, -1);
  lowering.hostDefinitions.push({
    definition: name,
    capability: TEXT_CAPABILITY,
    field: operation,
  });
  return name;
}

function textIntrinsic(operation: string): WasmIntrinsic {
  if (operation === "length") return WasmIntrinsic.TextCodePointLength;
  if (operation === "of_int") {
    return WasmIntrinsic.TextFromSignedInteger64;
  }
  if (operation === "compare") return WasmIntrinsic.TextCompare;
  if (operation === "contains") return WasmIntrinsic.TextContains;
  throw new Error(`Blot text operation ${operation} has no Wasm intrinsic`);
}

/**
 * A blot type value, as a boundary type.
 *
 * Only the scalars and text cross today. A shape would need a nominal on both
 * sides of the boundary, and inventing one silently would make the import's
 * contract a guess.
 */
function boundaryType(
  value: Value,
  span: Span,
  lowering: Lowering,
): TypeSchema {
  if (value.tag === "extended") {
    return boundaryType(value.inner, span, lowering);
  }
  if (value.tag === "unit") return { kind: "unit" };
  if (value.tag === "range") {
    const domain = value.domain ??
      (value.low.tag === "int" || value.high.tag === "int" ? "int" : "text");
    if (domain === "int") return { kind: "signed-integer-64" };
    return HostTypes.text;
  }
  if (value.tag === "shape") {
    const nominal = lowering.nominal([...value.fields.keys()]);
    return {
      kind: "named",
      name: nominal.name,
      arguments: nominal.fields.map((field) => {
        const member = value.fields.get(field);
        if (member === undefined) {
          throw new Error(`host boundary record omitted field ${field}`);
        }
        return boundaryType(member, span, lowering);
      }),
    };
  }
  if (value.tag === "sealed") {
    const sealed = lowering.seal(value.name);
    return {
      kind: "named",
      name: sealed.name,
      arguments: [boundaryType(value.inner, span, lowering)],
    };
  }
  if (value.tag === "tag") {
    let payload = false;
    if (value.payload !== null) payload = true;
    const sum = lowering.sum([{ name: value.name, payload }]);
    const arguments_: TypeSchema[] = [];
    if (value.payload !== null) {
      arguments_.push(boundaryType(value.payload, span, lowering));
    }
    return { kind: "named", name: sum.name, arguments: arguments_ };
  }
  if (value.tag === "union") {
    const cases: { readonly name: string; readonly payload: Value | null }[] = [];
    for (const member of value.members) {
      if (member.tag !== "tag") {
        return valueExportSchema(value, "host operation", span, lowering);
      }
      cases.push({
        name: member.name,
        payload: member.payload,
      });
    }
    const names = cases.map((case_) => case_.name);
    if (
      names.length > 0 &&
      names.every((name) => name === "True" || name === "False")
    ) return { kind: "boolean" };
    const sum = lowering.sum(cases.map((case_) => ({
      name: case_.name,
      payload: case_.payload !== null,
    })));
    return {
      kind: "named",
      name: sum.name,
      arguments: sum.cases.flatMap((case_) => {
        const matching = cases.find((candidate) => candidate.name === case_.name);
        if (matching === undefined) {
          throw new Error(`host boundary variant omitted case ${case_.name}`);
        }
        if (matching.payload === null) return [];
        return [boundaryType(matching.payload, span, lowering)];
      }),
    };
  }
  return valueExportSchema(value, "host operation", span, lowering);
}

/**
 * A block, as nested Core forms.
 *
 * Each declaration contributes a wrapper around everything after it, because a
 * destructuring binding is a `case` and not a `let` — Core has no pattern
 * binder, so `let { .x; } = p;` becomes the match it always meant.
 */
function lowerBlock(
  declarations: Module["declarations"],
  result: Expr,
  scope: Scope,
  lowering: Lowering,
): SurfaceExpression {
  const inner = childScope(scope);
  const wrappers: ((body: SurfaceExpression) => SurfaceExpression)[] = [];

  for (const declaration of declarations) {
    // `open` emits nothing — a use of a name it brought in specializes to the
    // compile-time value, exactly as a `const` does — but the names still have
    // to be *in* this scope. An imported module is inlined into the importer's
    // scope, so its own `open` has to install them here rather than relying on
    // whatever the importer happened to open.
    if (declaration.tag === "open") {
      const opened = lowering.facts.opens.get(declaration.value);
      if (opened === undefined) {
        return unsupported(
          "an `open` the checker did not record",
          declaration.span,
        );
      }
      for (const [name, value] of opened) inner.values.names.set(name, value);
      continue;
    }
    if (declaration.tag === "shadow") {
      const known = lowering.facts.comptimeValues.get(declaration.value);
      if (known !== undefined) inner.values.names.set(declaration.name, known);
      // A binding whose value has no runtime representation emits nothing, the
      // same rule that makes `const Message = #Ready | …` disappear. Shadowing
      // an effect or a type is rebinding a compile-time name, not code.
      if (compileTimeOnly(known)) continue;
      const value = lower(declaration.value, inner, lowering);
      const name = lowering.fresh(declaration.name);
      inner.names.set(declaration.name, name);
      wrappers.push((body) => surface.let(name, value, body));
      continue;
    }

    // Remembered before the compile-time skip below: a handler bound to a
    // `const` is still written in this module, and `@handle` needs its clauses.
    if (
      (declaration.value.tag === "shape" ||
        declaration.value.tag === "lambda") &&
      declaration.pattern.tag === "name"
    ) {
      inner.literals.set(declaration.pattern.name, declaration.value);
    }

    // A `const` the checker evaluated is compile time and emits nothing: a use
    // specializes it, so one holding a type disappears and one holding a
    // closure becomes a definition only if something calls it.
    //
    // A `const` inside a function body is a different animal. `const rest =
    // resume ();` depends on the parameter, so there is no compile-time value
    // to specialize and it has to become an ordinary binding.
    if (declaration.kind === "const" && declaration.pattern.tag === "name") {
      const known = lowering.facts.comptimeValues.get(declaration.value);
      if (known !== undefined) {
        inner.values.names.set(declaration.pattern.name, known);
        continue;
      }
    }
    if (declaration.kind === "sig") continue;

    // `rec` becomes a *local* recursive binding. Lifting it to a top-level
    // definition would strand whatever the lambda captured.
    if (
      declaration.value.tag === "rec" &&
      declaration.value.lambda.tag === "lambda" &&
      declaration.pattern.tag === "name"
    ) {
      wrappers.push(
        recursiveBinding(
          declaration.pattern.name,
          declaration.value.lambda,
          inner,
          lowering,
        ),
      );
      continue;
    }

    if (
      (declaration.value.tag === "shape" ||
        declaration.value.tag === "lambda") &&
      declaration.pattern.tag === "name"
    ) {
      inner.literals.set(declaration.pattern.name, declaration.value);
    }
    const value = lower(declaration.value, inner, lowering);
    wrappers.push(bind(declaration.pattern, value, inner, lowering));
  }

  let body = lower(result, inner, lowering);
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    body = wrappers[index](body);
  }
  return body;
}

/**
 * Binds a pattern, returning a wrapper around whatever follows it. A compound
 * pattern is a `case` with one arm: Core has no destructuring binder, and the
 * match is what the pattern always described.
 */
function bind(
  pattern: Pattern,
  value: SurfaceExpression,
  scope: Scope,
  lowering: Lowering,
): (body: SurfaceExpression) => SurfaceExpression {
  const at = surface.at({
    startByte: pattern.span.start,
    endByte: pattern.span.end,
  });

  if (pattern.tag === "name") {
    const name = lowering.fresh(pattern.name);
    scope.names.set(pattern.name, name);
    return (body) => surface.let(name, value, body);
  }

  if (pattern.tag === "wildcard" || pattern.tag === "unit") {
    return (body) => surface.let(lowering.fresh("_"), value, body);
  }

  if (pattern.tag === "array") {
    const store = lowering.fresh("store");
    const wrappers = pattern.elements.map((element, index) =>
      bind(
        element,
        at.storeRead(at.name(store), at.integer(index)),
        scope,
        lowering,
      )
    );
    return (body) => {
      let inner = body;
      for (let index = wrappers.length - 1; index >= 0; index -= 1) {
        inner = wrappers[index](inner);
      }
      return surface.let(
        store,
        value,
        at.if(
          at.binary(
            BinaryOperator.Equal,
            at.storeLength(at.name(store)),
            at.integer(pattern.elements.length),
          ),
          inner,
          at.runtimeFault(
            `array pattern expected ${pattern.elements.length} elements`,
          ),
        ),
      );
    };
  }

  if (pattern.tag === "tuple" || pattern.tag === "shape") {
    // The *value's* field set, not the pattern's: width subtyping means
    // `let { .x; } = point;` names fewer than arrive, and Core records are
    // nominal.
    const names = pattern.tag === "tuple"
      ? pattern.elements.map((_, index) => String(index))
      : lowering.facts.patternShapes.get(pattern) ??
        pattern.fields.map((field) => field.name);
    const nominal = lowering.nominal(names);
    const parts = pattern.tag === "tuple"
      ? pattern.elements.map((element, index) => ({
        name: String(index),
        element,
      }))
      : pattern.fields.map((field) => ({
        name: field.name,
        element: field.pattern,
      }));

    const nested: ((body: SurfaceExpression) => SurfaceExpression)[] = [];
    const binders = nominal.fields.map((name) => {
      const part = parts.find((entry) => entry.name === name);
      if (part === undefined) return lowering.fresh("_");
      if (part.element.tag === "wildcard") return lowering.fresh("_");
      const bound = lowering.fresh("part");
      if (part.element.tag === "name") {
        scope.names.set(part.element.name, bound);
      } else {
        nested.push(
          bind(part.element, at.name(bound), scope, lowering),
        );
      }
      return bound;
    });

    return (body) => {
      let inner = body;
      for (let index = nested.length - 1; index >= 0; index -= 1) {
        inner = nested[index](inner);
      }
      return at.case(value, [{
        constructor: nominal.name,
        binders,
        body: inner,
      }]);
    };
  }

  if (pattern.tag === "constructor") {
    const sum = lowering.sumFor(
      pattern.name,
      pattern.payload !== null,
      pattern.span,
    );
    if (pattern.payload === null) {
      return (body) =>
        at.case(value, [{
          constructor: constructorName(sum, pattern.name),
          binders: [],
          body,
        }], { body: at.runtimeFault("constructor pattern did not match") });
    }
    const payload = lowering.fresh("payload");
    const nested = bind(
      pattern.payload,
      at.name(payload),
      scope,
      lowering,
    );
    return (body) =>
      at.case(value, [{
        constructor: constructorName(sum, pattern.name),
        binders: [payload],
        body: nested(body),
      }], { body: at.runtimeFault("constructor pattern did not match") });
  }

  if (pattern.tag === "int" || pattern.tag === "text") {
    let literal: SurfaceExpression;
    let operator: BinaryOperator = BinaryOperator.Equal;
    if (pattern.tag === "int") {
      literal = at.signedInteger64(pattern.value);
      operator = BinaryOperator.EqualSignedInteger64;
    } else {
      literal = at.text(pattern.value);
    }
    return (body) =>
      at.if(
        at.binary(operator, value, literal),
        body,
        at.runtimeFault("literal pattern did not match"),
      );
  }

  pattern satisfies never;
  throw new Error("unhandled pattern in lowering");
}

/**
 * A `rec` binding, as a local recursive group.
 *
 * Core has `let-rec`, which is what this needs: the lambda may capture names
 * from the block it is written in, and only a local binding keeps those in
 * scope. Lifting it to a top-level definition stranded them — `fold`'s inner
 * `go` closes over `values`, and a definition has no enclosing scope for that
 * to come from. The surface builder has no helper for this node, so it is a
 * literal.
 */
function recursiveBinding(
  name: string,
  lambda: Expr & { tag: "lambda" },
  scope: Scope,
  lowering: Lowering,
): (body: SurfaceExpression) => SurfaceExpression {
  const binding = lowering.fresh(name);
  scope.names.set(name, binding);
  const inner = childScope(scope);
  const parameter = lowering.fresh("arg");
  const wrap = bindParameter(
    lambda.parameter,
    parameter,
    inner,
    lowering,
  );
  const value = wrap(lambda.body);
  const span = { startByte: lambda.span.start, endByte: lambda.span.end };
  return (body) => ({
    kind: "let-rec-group",
    bindings: [{ name: binding, parameters: [parameter], body: value, span }],
    body,
    span,
  });
}

function lower(
  expr: Expr,
  scope: Scope,
  lowering: Lowering,
): SurfaceExpression {
  const at = surface.at({ startByte: expr.span.start, endByte: expr.span.end });

  switch (expr.tag) {
    case "int":
      return at.signedInteger64(expr.value);

    case "text":
      return at.text(expr.value);

    case "unit":
      return at.name(UNIT_CONSTRUCTOR_NAME);

    // `#True` and `#False` are ordinary prelude constructors, and gpufuck's
    // conditions are booleans. Mapping the two is what lets `if` lower at all.
    case "tag": {
      if (expr.name === "True") return at.boolean(true);
      if (expr.name === "False") return at.boolean(false);
      const sum = lowering.sumFor(expr.name, false, expr.span);
      return at.name(constructorName(sum, expr.name));
    }

    case "var": {
      const name = resolve(scope, expr.name);
      if (name !== null) return at.name(name);
      // Not a local, so it is a compile-time binding: specialize it.
      const value = lookupValue(scope.values, expr.name);
      if (value === undefined) {
        // Inside a hoisted compile-time closure there is no enclosing frame,
        // and the checker has already proved this name is bound. So it is a
        // `let` — a binding with no value until the program runs — and the
        // `const` that reached for it was never computable at compile time.
        if (scope.hoisting !== undefined) {
          fail(
            "BLOT_CONST_CAPTURES_RUNTIME",
            `\`${expr.name}\` is bound by \`let\`, so it has no value at compile time and the compile-time closure \`${scope.hoisting}\` cannot capture it. Write \`let ${scope.hoisting} = …\`, or bind \`${expr.name}\` with \`const\`.`,
            expr.span,
          );
        }
        fail("BLOT_UNBOUND", `\`${expr.name}\` is not in scope.`, expr.span);
      }
      return lowerValue(value, expr.name, expr.span, lowering);
    }

    case "lambda": {
      const inner = childScope(scope);
      const parameter = lowering.fresh("arg");
      const body = bindParameter(
        expr.parameter,
        parameter,
        inner,
        lowering,
      );
      return at.lambda([parameter], body(expr.body));
    }

    case "apply":
      return lowerApply(expr, scope, lowering, at);

    case "tuple": {
      const nominal = lowering.nominal(
        expr.elements.map((_, index) => String(index)),
      );
      return at.apply(
        at.name(nominal.name),
        ...expr.elements.map((element) => lower(element, scope, lowering)),
      );
    }

    case "shape": {
      let fields: string[] = [];
      let built: SurfaceExpression = at.name(lowering.nominal([]).name);

      for (const member of expr.members) {
        if (member.tag === "field") {
          const previous = lowering.nominal(fields);
          const previousName = lowering.fresh("shape");
          const previousBinders = previous.fields.map((name) => lowering.fresh(name));
          const memberName = lowering.fresh(member.name);
          const nextFields = [...fields];
          if (!nextFields.includes(member.name)) nextFields.push(member.name);
          const next = lowering.nominal(nextFields);

          built = surface.let(
            previousName,
            built,
            surface.let(
              memberName,
              lower(member.value, scope, lowering),
              at.case(at.name(previousName), [{
                constructor: previous.name,
                binders: previousBinders,
                body: at.apply(
                  at.name(next.name),
                  ...next.fields.map((name) => {
                    if (name === member.name) return at.name(memberName);
                    const index = previous.fields.indexOf(name);
                    return at.name(previousBinders[index]);
                  }),
                ),
              }]),
            ),
          );
          fields = nextFields;
          continue;
        }

        const carried = lowering.facts.shapes.get(member.value);
        if (carried === undefined) {
          return unsupported(
            "spreading a shape inference could not pin down",
            expr.span,
          );
        }

        const previous = lowering.nominal(fields);
        const previousName = lowering.fresh("shape");
        const previousBinders = previous.fields.map((name) => lowering.fresh(name));
        const spread = lowering.nominal(carried);
        const spreadName = lowering.fresh("spread");
        const spreadBinders = spread.fields.map((name) => lowering.fresh(name));
        const nextFields = [...fields];
        for (const name of carried) {
          if (!nextFields.includes(name)) nextFields.push(name);
        }
        const next = lowering.nominal(nextFields);

        built = surface.let(
          previousName,
          built,
          surface.let(
            spreadName,
            lower(member.value, scope, lowering),
            at.case(at.name(previousName), [{
              constructor: previous.name,
              binders: previousBinders,
              body: at.case(at.name(spreadName), [{
                constructor: spread.name,
                binders: spreadBinders,
                body: at.apply(
                  at.name(next.name),
                  ...next.fields.map((name) => {
                    const spreadIndex = spread.fields.indexOf(name);
                    if (spreadIndex >= 0) {
                      return at.name(spreadBinders[spreadIndex]);
                    }
                    const previousIndex = previous.fields.indexOf(name);
                    return at.name(previousBinders[previousIndex]);
                  }),
                ),
              }]),
            }]),
          ),
        );
        fields = nextFields;
      }

      return built;
    }

    case "field": {
      // A field of the module parameter is a granted capability: an import,
      // declared from the signature inference found for it.
      if (
        expr.target.tag === "var" && expr.target.name === grantedName(scope)
      ) {
        const signature = lowering.facts.grants.get(expr);
        if (signature === undefined) {
          return unsupported(
            `the granted capability \`${expr.name}\`, whose signature inference could not pin down`,
            expr.span,
          );
        }
        return at.name(
          grantOperation(expr.name, signature, lowering, expr.span),
        );
      }
      // An operation on an effect is evidence, not a projection. A host
      // effect's is an import the host answers; a blot effect's is a definition
      // a handler can replace lexically.
      const performed = comptimeEffect(expr, scope);
      if (performed !== null) {
        return at.name(
          performed.host
            ? hostOperation(performed, expr.name, lowering, expr.span)
            : effectOperation(performed, expr.name, lowering, expr.span),
        );
      }
      // Projecting from a compile-time shape is folded rather than compiled:
      // `Num.add` should become a call to one definition, not a record built at
      // run time and immediately taken apart.
      const constant = comptimeShapeMember(expr, scope);
      if (constant !== null) {
        return lowerValue(constant, expr.name, expr.span, lowering);
      }
      const target = lower(expr.target, scope, lowering);
      // The whole field set comes from inference. A projection alone does not
      // say what else the record holds, and the nominal needs all of it.
      const names = lowering.facts.shapes.get(expr);
      if (names === undefined) {
        return unsupported(
          `projecting \`.${expr.name}\` from a value whose shape inference could not pin down`,
          expr.span,
        );
      }
      const nominal = lowering.nominal(names);
      // The nominal's own order, not this site's. Inference records a field set
      // in the order the program first projected it, so two sites can disagree
      // about the order of the same type — the nominal is the one that
      // decides, and construction already goes through it.
      const binders = nominal.fields.map((name) => lowering.fresh(name));
      const index = nominal.fields.indexOf(expr.name);
      if (index < 0) {
        fail("BLOT_NO_FIELD", `No field \`.${expr.name}\`.`, expr.span);
      }
      return at.case(target, [{
        constructor: nominal.name,
        binders,
        body: at.name(binders[index]),
      }]);
    }

    // An array is Core's `Store`: allocate at the first element's value, then
    // write the rest. There is no literal form, and `storeNew` needs something
    // to fill with, which is why an empty literal has no lowering — the element
    // type is not determined by anything.
    case "array": {
      if (expr.elements.length === 0) return at.storeEmpty();
      if (expr.elements.some((element) => element.spread)) {
        return lowerSpreadArray(expr, scope, lowering, at);
      }
      // A `Store` write returns a *new* store, so each element threads through
      // its own binding: allocate at the first element, then write the rest,
      // each read from the store the previous write produced.
      const steps: { name: string; value: SurfaceExpression }[] = [];
      const first = lowering.fresh("store");
      steps.push({
        name: first,
        value: at.storeNew(
          at.integer(expr.elements.length),
          lower(expr.elements[0].value, scope, lowering),
        ),
      });
      for (let index = 1; index < expr.elements.length; index += 1) {
        const previous = steps[steps.length - 1].name;
        steps.push({
          name: lowering.fresh("store"),
          value: at.storeWrite(
            at.name(previous),
            at.integer(index),
            lower(expr.elements[index].value, scope, lowering),
          ),
        });
      }
      let body: SurfaceExpression = at.name(steps[steps.length - 1].name);
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        body = surface.let(steps[index].name, steps[index].value, body);
      }
      return body;
    }

    case "if": {
      let result = expr.fallback === null
        ? at.runtimeFault("no branch matched")
        : lower(expr.fallback, scope, lowering);
      for (let index = expr.branches.length - 1; index >= 0; index -= 1) {
        const branch = expr.branches[index];
        result = at.if(
          lower(branch.condition, scope, lowering),
          lower(branch.consequence, scope, lowering),
          result,
        );
      }
      return result;
    }

    case "intrinsic": {
      if (expr.name === "@shape.empty") {
        return at.name(lowering.nominal([]).name);
      }
      // `storeEmpty` allocates a zero-length `Store a` and lets the
      // surrounding constraints infer `a`, which is exactly what an empty array
      // needs: there is no element to offer, and it should not have to invent
      // one. blot used to record the element type during checking and write a
      // typed placeholder — that worked only where the element was already
      // pinned, so `map` and `filter` did not compile.
      if (expr.name === "@array.empty") return at.storeEmpty();
      return unsupported(
        `the primitive \`${expr.name}\` as a value`,
        expr.span,
      );
    }

    case "case":
      return lowerCase(expr, scope, lowering, at);

    case "block":
      return lowerBlock(expr.declarations, expr.result, scope, lowering);

    case "comptime":
      return lower(expr.body, scope, lowering);

    case "rec":
      return unsupported("`rec` outside a named binding", expr.span);
  }
  // Every expression kind is handled above; this is the compiler's own
  // exhaustiveness check rather than a fallback.
  expr satisfies never;
  throw new Error("unhandled expression in lowering");
}

/**
 * An array literal with a spread.
 *
 * Lengths are not known until it runs, so it is built rather than allocated:
 * start empty, push each written element, and copy each spread with a local
 * recursive loop. `let-rec` is what makes the loop expressible — Core has no
 * other one, which is the same reason `rec` is a local binding.
 */
function lowerSpreadArray(
  expr: Expr & { tag: "array" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  // Each step names the store it produced, because a `Store` write returns a
  // new one rather than mutating.
  const steps: { name: string; value: SurfaceExpression }[] = [];
  const start = lowering.fresh("store");
  steps.push({ name: start, value: at.storeEmpty() });

  const push = (
    into: string,
    value: SurfaceExpression,
  ): string => {
    const next = lowering.fresh("store");
    steps.push({
      name: next,
      value: at.storeGrow(
        at.name(into),
        at.binary(
          BinaryOperator.Add,
          at.storeLength(at.name(into)),
          at.integer(1),
        ),
        value,
      ),
    });
    return next;
  };

  let current = start;
  for (const element of expr.elements) {
    const value = lower(element.value, scope, lowering);
    if (!element.spread) {
      current = push(current, value);
      continue;
    }
    current = appendAll(current, value, lowering, at, steps);
  }

  let body: SurfaceExpression = at.name(current);
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    body = surface.let(steps[index].name, steps[index].value, body);
  }
  return body;
}

/**
 * Copies every element of `source` onto `into`, as a local recursive loop.
 *
 * The loop carries an index and an accumulator, so it takes the pair as one
 * argument — Core application is unary, and a tuple is the shape blot already
 * uses for that.
 */
function appendAll(
  into: string,
  source: SurfaceExpression,
  lowering: Lowering,
  at: typeof surface,
  steps: { name: string; value: SurfaceExpression }[],
): string {
  const from = lowering.fresh("source");
  steps.push({ name: from, value: source });

  const pair = lowering.nominal(["0", "1"]);
  const loop = lowering.fresh("append");
  const argument = lowering.fresh("state");
  const index = lowering.fresh("index");
  const accumulator = lowering.fresh("acc");

  const grown = at.storeGrow(
    at.name(accumulator),
    at.binary(
      BinaryOperator.Add,
      at.storeLength(at.name(accumulator)),
      at.integer(1),
    ),
    at.storeRead(at.name(from), at.name(index)),
  );
  const step = at.apply(
    at.name(loop),
    at.apply(
      at.name(pair.name),
      at.binary(BinaryOperator.Add, at.name(index), at.integer(1)),
      grown,
    ),
  );
  const body = at.case(at.name(argument), [{
    constructor: pair.name,
    binders: [index, accumulator],
    body: at.if(
      at.binary(
        BinaryOperator.Less,
        at.name(index),
        at.storeLength(at.name(from)),
      ),
      step,
      at.name(accumulator),
    ),
  }]);

  const result = lowering.fresh("store");
  steps.push({
    name: result,
    value: {
      kind: "let-rec-group",
      bindings: [{ name: loop, parameters: [argument], body }],
      body: at.apply(
        at.name(loop),
        at.apply(at.name(pair.name), at.integer(0), at.name(into)),
      ),
    },
  });
  return result;
}

function lowerCase(
  expr: Expr & { tag: "case" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  // The constructor set inference pinned, or — when a wildcard arm left it
  // open — the union the named arms belong to. Recovering it from the arms is
  // what avoids monomorphizing: gpufuck keeps Core polymorphic on measured
  // grounds, and duplicating a definition per instantiation to learn a name
  // blot could have looked up would be the wrong trade.
  const cases = lowering.facts.variants.get(expr) ??
    unionFromArms(expr, lowering);
  if (cases === undefined) {
    // Not a union: matching literals is a chain of equality tests, which is
    // what the arms always described.
    return lowerLiteralCase(expr, scope, lowering, at);
  }

  // `#True | #False` is the prelude's `Bool`, and Core has a boolean. Matching
  // on it is an `if`, not a two-constructor dispatch.
  const sorted = [...cases].map((entry) => entry.name).sort();
  if (sorted.length === 2 && sorted[0] === "False" && sorted[1] === "True") {
    return lowerBooleanCase(expr, scope, lowering, at);
  }

  const sum = lowering.sum(cases);
  const target = lower(expr.target, scope, lowering);
  const arms: {
    constructor: string;
    binders: string[];
    body: SurfaceExpression;
  }[] = [];
  // Literal payloads collected first, because they are guards inside their
  // constructor's arm rather than arms of their own.
  const guarded: { name: string; literal: Pattern; body: Expr }[] = [];
  for (const arm of expr.arms) {
    if (arm.pattern.tag !== "constructor") continue;
    const payload = arm.pattern.payload;
    if (payload === null) continue;
    if (payload.tag !== "int" && payload.tag !== "text") continue;
    guarded.push({ name: arm.pattern.name, literal: payload, body: arm.body });
  }
  let fallback: SurfaceExpression | null = null;

  const covered = new Set<string>();
  for (const arm of expr.arms) {
    const inner = childScope(scope);
    if (arm.pattern.tag === "constructor") {
      // A constructor's payload has one type, so a second arm for it can only
      // be reached when the first was refutable — and the refutable ones are
      // the literal payloads, already lifted out as guards. Core takes one arm
      // per constructor, and the first is the one that runs.
      if (covered.has(arm.pattern.name)) continue;
      // A literal payload is a guard, not a binder: `#Progress 0` and
      // `#Progress n` are one Core arm with a test inside, because Core
      // dispatches on the constructor and nothing else.
      const payload = arm.pattern.payload;
      if (
        payload !== null && (payload.tag === "int" || payload.tag === "text")
      ) {
        continue;
      }
      const binders: string[] = [];
      // A compound payload binds one name and then destructures it, which is
      // the same `case` a compound binding already becomes.
      let wrap: ((body: SurfaceExpression) => SurfaceExpression) | null = null;
      if (payload !== null) {
        const binder = lowering.fresh("payload");
        binders.push(binder);
        if (payload.tag === "name") {
          inner.names.set(payload.name, binder);
        } else if (payload.tag !== "wildcard") {
          wrap = bind(payload, at.name(binder), inner, lowering);
        }
      }
      const armBody = lower(arm.body, inner, lowering);
      // Guards for this constructor run before its general arm.
      const constructor = arm.pattern.name;
      const tests = guarded.filter((entry) => entry.name === constructor);
      let body = wrap === null ? armBody : wrap(armBody);
      for (let index = tests.length - 1; index >= 0; index -= 1) {
        const test = tests[index];
        const literal = test.literal;
        let compared: SurfaceExpression = at.text("");
        let operator: BinaryOperator = BinaryOperator.Equal;
        if (literal.tag === "int") {
          compared = at.signedInteger64(literal.value);
          operator = BinaryOperator.EqualSignedInteger64;
        } else if (literal.tag === "text") {
          compared = at.text(literal.value);
        }
        body = at.if(
          at.binary(
            operator,
            at.name(binders[0]),
            compared,
          ),
          lower(test.body, inner, lowering),
          body,
        );
      }
      covered.add(constructor);
      arms.push({
        constructor: constructorName(sum, constructor),
        binders,
        body,
      });
      continue;
    }
    if (arm.pattern.tag === "wildcard" || arm.pattern.tag === "name") {
      if (arm.pattern.tag === "name") {
        const binder = lowering.fresh(arm.pattern.name);
        inner.names.set(arm.pattern.name, binder);
        // The default binds the scrutinee, which Core spells with its own
        // binder rather than reusing the arm's.
        fallback = surface.let(
          binder,
          target,
          lower(arm.body, inner, lowering),
        );
      } else {
        fallback = lower(arm.body, inner, lowering);
      }
      continue;
    }
    return unsupported(
      `a ${arm.pattern.tag} pattern in \`case\``,
      arm.pattern.span,
    );
  }

  if (fallback === null) return at.case(target, arms);
  return at.case(target, arms, { body: fallback });
}

/**
 * The union a `case`'s arms belong to, when inference could not pin it.
 *
 * A wildcard arm leaves the scrutinee's constructor set open, which is common
 * inside a polymorphic function — `case o of #Less => …, _ => …` says nothing
 * about `#Equal`. But the named arms do belong to a union, and the module has
 * only so many; the same membership lookup that resolves a construction
 * resolves this.
 */
function unionFromArms(
  expr: Expr & { tag: "case" },
  lowering: Lowering,
): readonly VariantCase[] | undefined {
  const named = expr.arms
    .map((arm) => arm.pattern)
    .filter((pattern) => pattern.tag === "constructor");
  if (named.length === 0) return undefined;
  const first = named[0];
  if (first.tag !== "constructor") return undefined;
  return lowering.sumFor(first.name, first.payload !== null, first.span).cases;
}

/**
 * `case` over literals, which is a chain of equality tests.
 *
 * A union dispatches on its constructor; an integer or a text has nothing to
 * dispatch on, so the arms become the comparisons they always meant.
 */
function lowerLiteralCase(
  expr: Expr & { tag: "case" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const scrutinee = lowering.fresh("subject");
  let fallback: SurfaceExpression | null = null;
  const tests: { literal: Pattern; body: SurfaceExpression }[] = [];

  for (const arm of expr.arms) {
    const inner = childScope(scope);
    const pattern = arm.pattern;
    if (pattern.tag === "int" || pattern.tag === "text") {
      tests.push({ literal: pattern, body: lower(arm.body, inner, lowering) });
      continue;
    }
    if (arm.pattern.tag === "wildcard" || arm.pattern.tag === "name") {
      if (arm.pattern.tag === "name") {
        inner.names.set(arm.pattern.name, scrutinee);
      }
      fallback = fallback ?? lower(arm.body, inner, lowering);
      continue;
    }
    if (pattern.tag === "constructor") {
      // The arms name constructors, so this *is* a union — inference just could
      // not pin the whole set, which happens when a wildcard arm leaves it open
      // inside a polymorphic function. Monomorphizing per call site is what
      // would close it.
      return unsupported(
        "matching a union whose constructor set a wildcard arm left open",
        arm.pattern.span,
      );
    }
    return unsupported(`a ${pattern.tag} pattern over a literal`, pattern.span);
  }

  let body = fallback ??
    at.runtimeFault("no arm matched");
  for (let index = tests.length - 1; index >= 0; index -= 1) {
    const test = tests[index];
    const value = test.literal;
    let literal = at.text("");
    let operator: BinaryOperator = BinaryOperator.Equal;
    if (value.tag === "int") {
      literal = at.signedInteger64(value.value);
      operator = BinaryOperator.EqualSignedInteger64;
    } else if (value.tag === "text") {
      literal = at.text(value.value);
    }
    body = at.if(
      at.binary(operator, at.name(scrutinee), literal),
      test.body,
      body,
    );
  }
  return surface.let(scrutinee, lower(expr.target, scope, lowering), body);
}

/** `case` over `#True | #False`, which Core already has as `if`. */
function lowerBooleanCase(
  expr: Expr & { tag: "case" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const target = lower(expr.target, scope, lowering);
  let whenTrue: SurfaceExpression | null = null;
  let whenFalse: SurfaceExpression | null = null;

  for (const arm of expr.arms) {
    const body = () => lower(arm.body, childScope(scope), lowering);
    if (arm.pattern.tag === "constructor" && arm.pattern.name === "True") {
      whenTrue = whenTrue ?? body();
    } else if (
      arm.pattern.tag === "constructor" && arm.pattern.name === "False"
    ) {
      whenFalse = whenFalse ?? body();
    } else if (arm.pattern.tag === "wildcard" || arm.pattern.tag === "name") {
      const rest = body();
      whenTrue = whenTrue ?? rest;
      whenFalse = whenFalse ?? rest;
    }
  }

  if (whenTrue === null || whenFalse === null) {
    return unsupported(
      "a `case` over booleans that covers only one of them",
      expr.span,
    );
  }
  return at.if(target, whenTrue, whenFalse);
}

/** `Console.write` when `Console` is an effect: the operation being performed. */
function comptimeEffect(
  expr: Expr & { tag: "field" },
  scope: Scope,
): (Value & { tag: "effect" }) | null {
  if (expr.target.tag !== "var") return null;
  if (resolve(scope, expr.target.name) !== null) return null;
  const value = lookupValue(scope.values, expr.target.name);
  if (value === undefined || value.tag !== "effect") return null;
  return value;
}

/**
 * Folds a chain of projections off a compile-time shape.
 *
 * `prelude.Num.add` is `.add` off `.Num` off a name, and stopping at the first
 * projection would leave `Num` — a shape of closures — as a value to compile.
 * Following the whole chain reaches the closure that is actually meant.
 */
function comptimeShapeMember(
  expr: Expr & { tag: "field" },
  scope: Scope,
): Value | null {
  const path: string[] = [];
  let current: Expr = expr;
  while (current.tag === "field") {
    path.unshift(current.name);
    current = current.target;
  }
  if (current.tag !== "var") return null;
  if (resolve(scope, current.name) !== null) return null;

  let value = lookupValue(scope.values, current.name);
  for (const name of path) {
    if (value === undefined || value.tag !== "shape") return null;
    value = value.fields.get(name);
  }
  return value ?? null;
}

/**
 * A compile-time value, as Core.
 *
 * A closure becomes a hoisted top-level definition, once per closure, so the
 * prelude is compiled rather than inlined at every use. Its body is lowered in
 * the environment it captured, which is what makes the recursion terminate on
 * closed values instead of chasing the whole prelude.
 */
function lowerValue(
  value: Value,
  hint: string,
  span: Span,
  lowering: Lowering,
): SurfaceExpression {
  const at = surface.at({ startByte: span.start, endByte: span.end });

  switch (value.tag) {
    case "int":
      return at.signedInteger64(value.value);
    case "text":
      return at.text(value.value);
    case "unit":
      return at.name(UNIT_CONSTRUCTOR_NAME);
    case "tag": {
      if (value.name === "True") return at.boolean(true);
      if (value.name === "False") return at.boolean(false);
      const sum = lowering.sumFor(value.name, value.payload !== null, span);
      const constructor = at.name(constructorName(sum, value.name));
      if (value.payload === null) return constructor;
      return at.apply(
        constructor,
        lowerValue(value.payload, hint, span, lowering),
      );
    }
    // Compile-time data crossing into run time. A `const` array or shape is an
    // ordinary value at that point, and building it is the same construction
    // the syntax would have produced.
    case "array": {
      if (value.elements.length === 0) return at.storeEmpty();
      const steps: { name: string; value: SurfaceExpression }[] = [];
      const first = lowering.fresh("store");
      steps.push({
        name: first,
        value: at.storeNew(
          at.integer(value.elements.length),
          lowerValue(value.elements[0], hint, span, lowering),
        ),
      });
      for (let index = 1; index < value.elements.length; index += 1) {
        const previous = steps[steps.length - 1].name;
        steps.push({
          name: lowering.fresh("store"),
          value: at.storeWrite(
            at.name(previous),
            at.integer(index),
            lowerValue(value.elements[index], hint, span, lowering),
          ),
        });
      }
      let built: SurfaceExpression = at.name(steps[steps.length - 1].name);
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        built = surface.let(steps[index].name, steps[index].value, built);
      }
      return built;
    }

    case "shape": {
      const nominal = lowering.nominal([...value.fields.keys()]);
      return at.apply(
        at.name(nominal.name),
        ...nominal.fields.map((name) => lowerValue(value.fields.get(name)!, name, span, lowering)),
      );
    }

    case "sealed": {
      const sealed = lowering.seal(value.name);
      return at.apply(
        at.name(sealed.constructor),
        lowerValue(value.inner, hint, span, lowering),
      );
    }

    case "closure": {
      const existing = lowering.hoisted.get(value);
      if (existing !== undefined) return at.name(existing);
      const name = lowering.fresh(hint);
      lowering.hoisted.set(value, name);

      const scope = childScope(null, value.env);
      scope.hoisting = hint;
      // `rec` names the closure itself, so the definition has to be in scope
      // inside its own body.
      if (value.self !== null) scope.names.set(value.self, name);
      const parameter = lowering.fresh("arg");
      const body = bindParameter(
        value.parameter,
        parameter,
        scope,
        lowering,
      );
      lowering.definitions.push({
        name,
        parameters: [parameter],
        annotation: null,
        body: body(value.body),
      });
      return at.name(name);
    }
    // A type, a union, an effect: real compile-time values with no runtime
    // representation at all. Saying "not lowered yet" would suggest it is
    // coming; it is not, because there is nothing to lower it to.
    case "range":
    case "union":
    case "arrow":
    case "unbounded":
    case "effect":
      fail(
        "BLOT_NOT_A_RUNTIME_VALUE",
        `\`${hint}\` is a compile-time value — a type or an effect — and has no runtime representation. It cannot cross into WebAssembly.`,
        span,
      );
      break;

    default:
      return unsupported(`the compile-time value \`${hint}\``, span);
  }
  return unsupported(`the compile-time value \`${hint}\``, span);
}

/**
 * Binds a lambda's parameter, returning a function that wraps a lowered body.
 * A tuple parameter is one shape argument, so it becomes one binder and a
 * projection per element.
 */
function bindParameter(
  pattern: Pattern,
  parameter: string,
  scope: Scope,
  lowering: Lowering,
): (body: Expr) => SurfaceExpression {
  const at = surface.at({
    startByte: pattern.span.start,
    endByte: pattern.span.end,
  });
  const wrapper = bind(
    pattern,
    at.name(parameter),
    scope,
    lowering,
  );
  return (body) => wrapper(lower(body, scope, lowering));
}

function lowerIntegerBinary(
  operator: BinaryOperator,
  left: SurfaceExpression,
  right: SurfaceExpression,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  if (
    operator !== BinaryOperator.AddSignedInteger64 &&
    operator !== BinaryOperator.SubtractSignedInteger64 &&
    operator !== BinaryOperator.MultiplySignedInteger64
  ) {
    return at.binary(operator, left, right);
  }

  const leftName = lowering.fresh("left");
  const rightName = lowering.fresh("right");
  const resultName = lowering.fresh("result");
  const leftValue = at.name(leftName);
  const rightValue = at.name(rightName);
  const resultValue = at.name(resultName);
  const zero = at.signedInteger64(0n);
  const overflow = at.runtimeFault("integer overflow");
  let checked: SurfaceExpression;

  if (operator === BinaryOperator.AddSignedInteger64) {
    checked = at.if(
      at.binary(BinaryOperator.GreaterSignedInteger64, rightValue, zero),
      at.if(
        at.binary(
          BinaryOperator.LessSignedInteger64,
          resultValue,
          leftValue,
        ),
        overflow,
        resultValue,
      ),
      at.if(
        at.binary(BinaryOperator.LessSignedInteger64, rightValue, zero),
        at.if(
          at.binary(
            BinaryOperator.GreaterSignedInteger64,
            resultValue,
            leftValue,
          ),
          overflow,
          resultValue,
        ),
        resultValue,
      ),
    );
  } else if (operator === BinaryOperator.SubtractSignedInteger64) {
    checked = at.if(
      at.binary(BinaryOperator.GreaterSignedInteger64, rightValue, zero),
      at.if(
        at.binary(
          BinaryOperator.GreaterSignedInteger64,
          resultValue,
          leftValue,
        ),
        overflow,
        resultValue,
      ),
      at.if(
        at.binary(BinaryOperator.LessSignedInteger64, rightValue, zero),
        at.if(
          at.binary(
            BinaryOperator.LessSignedInteger64,
            resultValue,
            leftValue,
          ),
          overflow,
          resultValue,
        ),
        resultValue,
      ),
    );
  } else {
    const minimum = at.signedInteger64(-0x8000000000000000n);
    const negativeOne = at.signedInteger64(-1n);
    const minimumTimesNegativeOne = at.if(
      at.binary(
        BinaryOperator.EqualSignedInteger64,
        leftValue,
        negativeOne,
      ),
      at.if(
        at.binary(
          BinaryOperator.EqualSignedInteger64,
          rightValue,
          minimum,
        ),
        overflow,
        resultValue,
      ),
      at.if(
        at.binary(
          BinaryOperator.EqualSignedInteger64,
          rightValue,
          negativeOne,
        ),
        at.if(
          at.binary(
            BinaryOperator.EqualSignedInteger64,
            leftValue,
            minimum,
          ),
          overflow,
          resultValue,
        ),
        at.if(
          at.binary(BinaryOperator.EqualSignedInteger64, leftValue, zero),
          resultValue,
          at.if(
            at.binary(
              BinaryOperator.NotEqualSignedInteger64,
              at.binary(
                BinaryOperator.DivideSignedInteger64,
                resultValue,
                leftValue,
              ),
              rightValue,
            ),
            overflow,
            resultValue,
          ),
        ),
      ),
    );
    checked = minimumTimesNegativeOne;
  }

  return surface.let(
    leftName,
    left,
    surface.let(
      rightName,
      right,
      surface.let(
        resultName,
        at.binary(operator, leftValue, rightValue),
        checked,
      ),
    ),
  );
}

function lowerApply(
  expr: Expr & { tag: "apply" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  // A primitive with a Core operator becomes that operator rather than a call:
  // `@int.add a b` is `a + b`, not an application of a function that does not
  // exist at this level.
  const spine = flatten(expr);

  // `#Busy 41` builds a value; typing it through application would make the
  // constructor a function it is not.
  if (spine.callee.tag === "tag" && spine.args.length === 1) {
    if (spine.callee.name === "True" || spine.callee.name === "False") {
      return unsupported("a boolean constructor with a payload", expr.span);
    }
    const sum = lowering.sumFor(spine.callee.name, true, expr.span);
    return at.apply(
      at.name(constructorName(sum, spine.callee.name)),
      lower(spine.args[0], scope, lowering),
    );
  }

  if (spine.callee.tag === "intrinsic") {
    const operator = BINARY.get(spine.callee.name);
    if (operator !== undefined && spine.args.length === 2) {
      return lowerIntegerBinary(
        operator,
        lower(spine.args[0], scope, lowering),
        lower(spine.args[1], scope, lowering),
        lowering,
        at,
      );
    }
    // Text concatenation is its own Core node rather than an operator; the
    // builder has no helper for it, which is why this is a node literal.
    if (spine.callee.name === "@text.concat" && spine.args.length === 2) {
      return {
        kind: "text-append",
        left: lower(spine.args[0], scope, lowering),
        right: lower(spine.args[1], scope, lowering),
        span: { startByte: expr.span.start, endByte: expr.span.end },
      };
    }
    // One comparison primitive becomes two Core comparisons and a constructor.
    // `Eq` and `Ord` are prelude source over `@int.cmp`, so lowering it is what
    // makes every comparison in the language reach Wasm.
    if (spine.callee.name === "@int.cmp" && spine.args.length === 2) {
      const sum = lowering.sum([
        { name: "Less", payload: false },
        { name: "Equal", payload: false },
        { name: "Greater", payload: false },
      ]);
      const left = lowering.fresh("left");
      const right = lowering.fresh("right");
      const tag = (name: string): SurfaceExpression => at.name(constructorName(sum, name));
      return surface.let(
        left,
        lower(spine.args[0], scope, lowering),
        surface.let(
          right,
          lower(spine.args[1], scope, lowering),
          at.if(
            at.binary(
              BinaryOperator.LessSignedInteger64,
              at.name(left),
              at.name(right),
            ),
            tag("Less"),
            at.if(
              at.binary(
                BinaryOperator.EqualSignedInteger64,
                at.name(left),
                at.name(right),
              ),
              tag("Equal"),
              tag("Greater"),
            ),
          ),
        ),
      );
    }
    if (spine.callee.name === "@int.neg" && spine.args.length === 1) {
      return lowerIntegerBinary(
        BinaryOperator.SubtractSignedInteger64,
        at.signedInteger64(0n),
        lower(spine.args[0], scope, lowering),
        lowering,
        at,
      );
    }
    // A module is a function from a record to a record, and both are known at
    // compile time, so importing one is inlining it. `@import "x" arg` is the
    // imported module's body with `arg` bound to its parameter.
    if (spine.callee.name === "@import" && spine.args.length >= 1) {
      return lowerImport(spine, scope, lowering, expr.span);
    }
    if (spine.callee.name === "@handle" && spine.args.length === 1) {
      return lowerHandle(spine.args[0], scope, lowering, expr.span);
    }
    // Core carries text without measuring or rendering it, so inspecting text
    // *is* a host operation. blot declares the capability itself rather than
    // making every program declare an effect for something the language already
    // has — the import is still typed, declared, and visible in the module.
    if (spine.callee.name === "@text.len" && spine.args.length === 1) {
      return at.apply(
        at.name(
          textOperation(
            "length",
            HostTypes.text,
            { kind: "signed-integer-64" },
            lowering,
          ),
        ),
        lower(spine.args[0], scope, lowering),
      );
    }
    if (spine.callee.name === "@text.of_int" && spine.args.length === 1) {
      return at.apply(
        at.name(
          textOperation(
            "of_int",
            { kind: "signed-integer-64" },
            HostTypes.text,
            lowering,
          ),
        ),
        lower(spine.args[0], scope, lowering),
      );
    }
    // The host answers with a sign, and the ordering is built here — a variant
    // has no boundary representation, and inventing one for three constructors
    // would be a worse trade than one comparison.
    if (spine.callee.name === "@text.cmp" && spine.args.length === 2) {
      // Host operations are unary, and Core has tuple *types* but no tuple
      // expression — so the pair crosses as blot's own pair nominal, which the
      // boundary already knows how to encode as a constructor.
      const pair = lowering.nominal(["0", "1"]);
      const compare = textOperation(
        "compare",
        {
          kind: "named",
          name: pair.name,
          arguments: [HostTypes.text, HostTypes.text],
        },
        { kind: "signed-integer-64" },
        lowering,
      );
      const sign = lowering.fresh("sign");
      const sum = lowering.sum([
        { name: "Less", payload: false },
        { name: "Equal", payload: false },
        { name: "Greater", payload: false },
      ]);
      const tag = (name: string): SurfaceExpression => at.name(constructorName(sum, name));
      return surface.let(
        sign,
        at.apply(
          at.name(compare),
          at.apply(
            at.name(pair.name),
            lower(spine.args[0], scope, lowering),
            lower(spine.args[1], scope, lowering),
          ),
        ),
        at.if(
          at.binary(
            BinaryOperator.LessSignedInteger64,
            at.name(sign),
            at.signedInteger64(0n),
          ),
          tag("Less"),
          at.if(
            at.binary(
              BinaryOperator.EqualSignedInteger64,
              at.name(sign),
              at.signedInteger64(0n),
            ),
            tag("Equal"),
            tag("Greater"),
          ),
        ),
      );
    }
    if (
      spine.callee.name === "@text.contains" && spine.args.length === 2
    ) {
      const pair = lowering.nominal(["0", "1"]);
      const contains = textOperation(
        "contains",
        {
          kind: "named",
          name: pair.name,
          arguments: [HostTypes.text, HostTypes.text],
        },
        { kind: "boolean" },
        lowering,
      );
      return at.apply(
        at.name(contains),
        at.apply(
          at.name(pair.name),
          lower(spine.args[0], scope, lowering),
          lower(spine.args[1], scope, lowering),
        ),
      );
    }
    if (spine.callee.name === "@array.len" && spine.args.length === 1) {
      return at.convert(
        NumericConversion.SignedInteger32ToSignedInteger64,
        at.storeLength(lower(spine.args[0], scope, lowering)),
      );
    }
    if (spine.callee.name === "@array.get" && spine.args.length === 2) {
      return at.storeRead(
        lower(spine.args[0], scope, lowering),
        at.convert(
          NumericConversion.SignedInteger64ToSignedInteger32,
          lower(spine.args[1], scope, lowering),
        ),
      );
    }
    if (spine.callee.name === "@array.set" && spine.args.length === 3) {
      return at.storeWrite(
        lower(spine.args[0], scope, lowering),
        at.convert(
          NumericConversion.SignedInteger64ToSignedInteger32,
          lower(spine.args[1], scope, lowering),
        ),
        lower(spine.args[2], scope, lowering),
      );
    }
    // Growing by one and filling the new slot with the value is an append.
    if (spine.callee.name === "@array.push" && spine.args.length === 2) {
      const store = lowering.fresh("store");
      return surface.let(
        store,
        lower(spine.args[0], scope, lowering),
        at.storeGrow(
          at.name(store),
          at.binary(
            BinaryOperator.Add,
            at.storeLength(at.name(store)),
            at.integer(1),
          ),
          lower(spine.args[1], scope, lowering),
        ),
      );
    }
    // A refusal that survived compiling is one the program reached at run time,
    // so it becomes a fault with the same message. `expect` is a prelude
    // function and gets lowered like any other, whether or not this arm of it
    // can be taken.
    if (spine.callee.name === "@fail" && spine.args.length === 1) {
      const message = spine.args[0];
      return surface.runtimeFault(
        message.tag === "text" ? message.value : "refused",
      );
    }
    // Checked while compiling, so nothing survives into the runtime: the value
    // passes through, and a failure was already a diagnostic.
    if (spine.callee.name === "@satisfies" && spine.args.length === 2) {
      return lower(spine.args[0], scope, lowering);
    }
    if (
      spine.callee.name === "@linear.own" ||
      spine.callee.name === "@linear.borrow"
    ) {
      return lower(spine.args[0], scope, lowering);
    }
    return unsupported(`the primitive \`${spine.callee.name}\``, expr.span);
  }

  return at.apply(
    lower(spine.callee, scope, lowering),
    ...spine.args.map((argument) => lower(argument, scope, lowering)),
  );
}

/** `@handle` becomes selective CPS before anything reaches gpufuck. */
function lowerHandle(
  argument: Expr,
  scope: Scope,
  lowering: Lowering,
  span: Span,
): SurfaceExpression {
  if (argument.tag !== "tuple" || argument.elements.length !== 3) {
    return unsupported(
      "`@handle` without `(effect, computation, handler)`",
      span,
    );
  }
  const [effectExpr, computation, handlerExpr] = argument.elements;

  if (effectExpr.tag !== "var") {
    return unsupported("a `@handle` whose effect is not a name", span);
  }
  const effect = lookupValue(scope.values, effectExpr.name);
  if (effect === undefined || effect.tag !== "effect") {
    return unsupported("a `@handle` whose effect is not compile-time", span);
  }
  if (effect.host) {
    return unsupported("handling a host effect inside blot", span);
  }
  const handler = handlerExpr.tag === "shape"
    ? handlerExpr
    : handlerExpr.tag === "var"
    ? resolveLiteral(scope, handlerExpr.name)
    : null;
  if (handler === null || handler.tag !== "shape") {
    return unsupported(
      "a handler whose clauses are not written as a shape in this module",
      span,
    );
  }

  let returnClause: Expr | null = null;
  const clauses = new Map<string, Expr>();
  for (const member of handler.members) {
    if (member.tag !== "field") {
      return unsupported("a spread in a handler", span);
    }
    if (member.name === "return") {
      returnClause = member.value;
      continue;
    }
    clauses.set(member.name, member.value);
  }

  const thunk = computation.tag === "lambda"
    ? computation
    : computation.tag === "var"
    ? resolveLiteral(scope, computation.name)
    : null;
  if (thunk === null || thunk.tag !== "lambda") {
    return unsupported(
      "a `@handle` whose computation is not a lambda written in this module",
      span,
    );
  }
  if (thunk.parameter.tag !== "unit" && thunk.parameter.tag !== "wildcard") {
    return unsupported("a handled computation that takes an argument", span);
  }

  const cps = (
    expr: Expr,
    continuation: (value: Expr) => Expr,
  ): Expr => {
    if (expr.tag === "apply") {
      const performed = flatten(expr);
      if (performed.callee.tag === "field" && performed.args.length === 1) {
        const performedEffect = comptimeEffect(performed.callee, scope);
        if (performedEffect !== null && performedEffect.id === effect.id) {
          const clause = clauses.get(performed.callee.name);
          if (clause === undefined) {
            fail(
              "BLOT_TYPE_ERROR",
              `Handler for \`${effect.name}\` has no \`.${performed.callee.name}\` clause.`,
              expr.span,
            );
          }
          return cps(performed.args[0], (operationArgument) => {
            const resumed = lowering.fresh("resumed");
            const resume: Expr = {
              tag: "lambda",
              parameter: {
                tag: "name",
                name: resumed,
                qualifier: "affine",
                span: expr.span,
              },
              body: continuation({
                tag: "var",
                name: resumed,
                span: expr.span,
              }),
              span: expr.span,
            };
            return {
              tag: "apply",
              fn: clause,
              arg: {
                tag: "tuple",
                elements: [operationArgument, resume],
                span: expr.span,
              },
              span: expr.span,
            };
          });
        }
      }
      return cps(
        expr.fn,
        (fn) =>
          cps(
            expr.arg,
            (arg) => continuation({ tag: "apply", fn, arg, span: expr.span }),
          ),
      );
    }

    if (expr.tag === "field") {
      return cps(expr.target, (target) => continuation({ ...expr, target }));
    }

    if (expr.tag === "tuple") {
      const elements: Expr[] = [];
      const sequence = (index: number): Expr => {
        if (index === expr.elements.length) {
          return continuation({ ...expr, elements });
        }
        return cps(expr.elements[index], (element) => {
          elements.push(element);
          return sequence(index + 1);
        });
      };
      return sequence(0);
    }

    if (expr.tag === "array") {
      const elements: ArrayElement[] = [];
      const sequence = (index: number): Expr => {
        if (index === expr.elements.length) {
          return continuation({ ...expr, elements });
        }
        const element = expr.elements[index];
        return cps(element.value, (value) => {
          elements.push({ spread: element.spread, value });
          return sequence(index + 1);
        });
      };
      return sequence(0);
    }

    if (expr.tag === "shape") {
      const members: ShapeMember[] = [];
      const sequence = (index: number): Expr => {
        if (index === expr.members.length) {
          return continuation({ ...expr, members });
        }
        const member = expr.members[index];
        return cps(member.value, (value) => {
          if (member.tag === "field") {
            members.push({ tag: "field", name: member.name, value });
          } else {
            members.push({ tag: "spread", value });
          }
          return sequence(index + 1);
        });
      };
      return sequence(0);
    }

    if (expr.tag === "if") {
      const branch = (index: number): Expr | null => {
        if (index === expr.branches.length) {
          if (expr.fallback === null) return null;
          return cps(expr.fallback, continuation);
        }
        const current = expr.branches[index];
        return cps(current.condition, (condition) => ({
          tag: "if",
          branches: [{
            condition,
            consequence: cps(current.consequence, continuation),
          }],
          fallback: branch(index + 1),
          span: expr.span,
        }));
      };
      const transformed = branch(0);
      if (transformed === null) {
        fail(
          "BLOT_TYPE_ERROR",
          "A handled conditional must have at least one branch.",
          expr.span,
        );
      }
      return transformed;
    }

    if (expr.tag === "case") {
      return cps(expr.target, (target) => ({
        ...expr,
        target,
        arms: expr.arms.map((arm) => ({
          ...arm,
          body: cps(arm.body, continuation),
        })),
      }));
    }

    if (expr.tag === "block") {
      const sequence = (index: number): Expr => {
        if (index === expr.declarations.length) {
          return cps(expr.result, continuation);
        }
        const declaration = expr.declarations[index];
        if (declaration.tag === "binding" && declaration.kind === "sig") {
          return sequence(index + 1);
        }
        return cps(declaration.value, (value) => {
          const rewritten = { ...declaration, value } as Decl;
          return {
            tag: "block",
            declarations: [rewritten],
            result: sequence(index + 1),
            span: expr.span,
          };
        });
      };
      return sequence(0);
    }

    return continuation(expr);
  };

  const transformed = cps(thunk.body, (value) => {
    if (returnClause === null) return value;
    return {
      tag: "apply",
      fn: returnClause,
      arg: value,
      span,
    };
  });
  return lower(transformed, childScope(scope), lowering);
}

/**
 * An imported module, inlined.
 *
 * A module is a function from its input record to its export record, resolved
 * while compiling. Its body is ordinary blot, so lowering it is lowering a
 * block — the import boundary exists for authority, not for code generation.
 */
function lowerImport(
  spine: { callee: Expr; args: Expr[] },
  scope: Scope,
  lowering: Lowering,
  span: Span,
): SurfaceExpression {
  const specifier = spine.args[0];
  if (specifier.tag !== "text") {
    return unsupported("an `@import` whose path is not a literal", span);
  }
  const dependency = lowering.facts.modules.get(specifier);
  if (dependency === undefined) {
    return unsupported(`the import \`${specifier.value}\``, span);
  }
  if (spine.args.length === 1) {
    return unsupported(
      `\`@import "${specifier.value}"\` used without calling it — a module is a function, and its exports are what calling it produces`,
      span,
    );
  }

  const inner = childScope(scope, dependency.values);
  const parameter = dependency.module.parameter;
  const wrapper = parameter === null
    ? null
    : bind(parameter, lower(spine.args[1], scope, lowering), inner, lowering);

  const body = lowerBlock(
    dependency.module.declarations,
    dependency.module.result,
    inner,
    lowering,
  );
  return wrapper === null ? body : wrapper(body);
}

function flatten(expr: Expr): { callee: Expr; args: Expr[] } {
  const args: Expr[] = [];
  let current = expr;
  while (current.tag === "apply") {
    args.unshift(current.arg);
    current = current.fn;
  }
  return { callee: current, args };
}

function unsupported(what: string, span: Span): never {
  fail(
    "BLOT_UNSUPPORTED_LOWERING",
    `${what} is not lowered to Wasm yet.`,
    span,
  );
}
