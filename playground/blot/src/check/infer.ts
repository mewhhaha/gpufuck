// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// The typing rules.
//
// Two things here are not standard bookkeeping and are worth reading closely.
//
// **Effects are ambient.** `infer` carries a row that every performed effect and
// every called function's row flows into. A lambda gives its body a fresh row
// and puts it in its own type. That is all effect inference is — there is no
// separate pass, because a row is a lattice element and `constrain` already
// knows how to join one.
//
// **`const` is checked through its value.** A `const` is a compile-time value,
// and if that value is a type — a range, a union, an effect, a shape of types —
// then it *is* the binding's type, bridged rather than inferred. That is the
// mechanism that lets `const Console = @effect {...}` give `Console.write` a row
// without a single annotation, and it is why blot needs no type sublanguage.

import type { Decl, Expr, Module, Pattern, Span } from "../syntax/ast.ts";
import { BlotError, fail } from "../diagnostic.ts";
import type { Env as ValueEnv } from "../comptime/value.ts";
import { childEnv, lookup as lookupValue, show, type Value } from "../comptime/value.ts";
import {
  bind,
  evaluate,
  evaluationRuntime,
  type Imports,
  resolveOpenBindings,
  run,
} from "../comptime/eval.ts";
import { bridge, effectLabel } from "./bridge.ts";
import { showLiterals, uncovered, unlistable } from "./coverage.ts";
import { complement, mirror, type Ordering, recognise, region } from "./narrow.ts";
import { intersect } from "./setops.ts";
import { constrain, instantiate, instantiateForall, scheme, TypeError_ } from "./constrain.ts";
import { PRIMITIVE_TYPES } from "./primitives.ts";
import { show as showType } from "./print.ts";
import {
  effects,
  freshVar,
  INT,
  intLiteral,
  type Level,
  openVariant,
  record,
  type SimpleType,
  TEXT,
  textLiteral,
  TOP,
  tupleType,
  type Typing,
  UNIT,
  variant,
} from "./type.ts";

interface TypeEnv {
  readonly names: Map<string, Typing>;
  readonly literals: Map<string, Expr>;
  /**
   * The compile-time value a binding installed *alongside* the type it put in
   * `names`, together with that exact `Typing` object.
   *
   * `context.values` cannot answer this question. A plain `let` and a lambda
   * parameter write only the type environment, so a runtime shadow of `Eq` is
   * invisible there while being entirely visible to evaluation — and a checker
   * that read the compile-time `Eq` through a runtime shadow of it would prove
   * facts about a function the program never calls. Pairing the value with the
   * `Typing` object makes that detectable: a later binding installs a different
   * object, so `lookupComptime` sees the mismatch and declines.
   */
  readonly comptime: Map<string, { value: Value; typing: Typing }>;
  readonly parent: TypeEnv | null;
}

function childTypeEnv(parent: TypeEnv | null): TypeEnv {
  return {
    names: new Map(),
    literals: new Map(),
    comptime: new Map(),
    parent,
  };
}

function lookupType(env: TypeEnv, name: string): Typing | undefined {
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.names.get(name);
    if (found !== undefined) return found;
    scope = scope.parent;
  }
  return undefined;
}

/**
 * The compile-time value of `name`, but only when the binding that gives `name`
 * its type is the same one that recorded the value.
 *
 * This is the whole of the shadowing story. `let Eq = { .eq = a => (b => True); };`
 * installs a fresh `Typing` for `Eq` and records no value, so the recorded pair
 * from the enclosing `open` no longer matches and this answers `null` — the
 * checker proves nothing rather than proving something about the prelude's `Eq`
 * while the program calls the user's. A lambda parameter named `Eq` is refused
 * for the same reason, which matters because no analysis of a compile-time value
 * could ever be sound when the caller supplies the function.
 */
function lookupComptime(env: TypeEnv, name: string): Value | null {
  const typing = lookupType(env, name);
  if (typing === undefined) return null;
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.comptime.get(name);
    if (found !== undefined) {
      if (found.typing !== typing) return null;
      return found.value;
    }
    scope = scope.parent;
  }
  return null;
}

/** Pairs a name's compile-time value with the `Typing` installed beside it. */
function recordComptimeBinding(
  scope: TypeEnv,
  name: string,
  value: Value,
): void {
  const typing = scope.names.get(name);
  if (typing === undefined) return;
  scope.comptime.set(name, { value, typing });
}

function lookupLiteral(env: TypeEnv, name: string): Expr | undefined {
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.literals.get(name);
    if (found !== undefined) return found;
    scope = scope.parent;
  }
  return undefined;
}

interface Context {
  /** Field sets and constructor sets, recorded for the backend. */
  readonly shapes: Map<Expr, readonly string[]>;
  /** Compile-time declaration values, keyed by their source expression. */
  readonly comptimeValues: Map<Expr, Value>;
  /** Facts read after checking, once every constraint has been seen. */
  readonly pending: (() => void)[];
  readonly variants: Map<Expr, readonly VariantCase[]>;
  readonly patternShapes: Map<Pattern, readonly string[]>;
  readonly grants: Map<Expr, GrantSignature>;
  /** The entry module's parameter name, when it has one. */
  parameterName: string | null;
  readonly types: TypeEnv;
  /** Comptime bindings, for bridging `sig` expressions and `const` values. */
  readonly values: ValueEnv;
  readonly imports: Imports;
  /** Checked types of imported modules, keyed by the specifier as written. */
  readonly modules: ReadonlyMap<string, SimpleType>;
  readonly opens: Map<Expr, ReadonlyMap<string, Value>>;
}

function located<T>(span: Span, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof TypeError_) {
      fail("BLOT_TYPE_ERROR", `${error.detail}.`, span);
    }
    throw error;
  }
}

/**
 * Evaluates a compile-time expression, or returns null if it cannot be reached
 * without running the program. A `sig` that depends on a runtime value is a
 * diagnostic elsewhere, not a reason to guess here.
 */
function comptime(expr: Expr, context: Context): ReturnType<typeof run> | null {
  try {
    return run(
      evaluate(
        expr,
        context.values,
        evaluationRuntime(context.imports, "comptime"),
      ),
    );
  } catch (error) {
    // A refusal is the program asking to fail, not the evaluator failing to
    // reach a value. Swallowing it would make `expect` silent at `blot check`
    // and only speak at `blot run`, which is the wrong half of the compiler.
    if (refusal(error)) throw error;
    return null;
  }
}

function refusal(error: unknown): boolean {
  return error instanceof BlotError && error.diagnostic.code === "BLOT_REFUSED";
}

function requireComptime(
  expr: Expr,
  context: Context,
  what: string,
): ReturnType<typeof run> {
  try {
    return run(
      evaluate(
        expr,
        context.values,
        evaluationRuntime(context.imports, "comptime"),
      ),
    );
  } catch (error) {
    if (refusal(error)) throw error;
    if (
      error instanceof BlotError &&
      (error.diagnostic.code === "BLOT_UNBOUND" ||
        error.diagnostic.code === "BLOT_UNHANDLED_EFFECT")
    ) {
      fail(
        "BLOT_NOT_COMPTIME",
        `${what} must be known at compile time: ${error.diagnostic.message}`,
        expr.span,
      );
    }
    throw error;
  }
}

function requireComptimeBinding(
  pattern: Pattern,
  expr: Expr,
  context: Context,
): ReturnType<typeof run> {
  try {
    return run(
      bind(
        pattern,
        expr,
        context.values,
        evaluationRuntime(context.imports, "comptime"),
      ),
    );
  } catch (error) {
    if (refusal(error)) throw error;
    if (
      error instanceof BlotError &&
      (error.diagnostic.code === "BLOT_UNBOUND" ||
        error.diagnostic.code === "BLOT_UNHANDLED_EFFECT")
    ) {
      fail(
        "BLOT_NOT_COMPTIME",
        `A \`const\` binding must be known at compile time: ${error.diagnostic.message}`,
        expr.span,
      );
    }
    throw error;
  }
}

export function infer(
  expr: Expr,
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType {
  switch (expr.tag) {
    case "int":
      return intLiteral(expr.value);
    case "text":
      return textLiteral(expr.value);
    case "unit":
      return UNIT;

    case "var": {
      const found = lookupType(context.types, expr.name);
      if (found === undefined) {
        fail("BLOT_UNBOUND", `\`${expr.name}\` is not in scope.`, expr.span);
      }
      return instantiate(found, level);
    }

    case "intrinsic": {
      const primitive = PRIMITIVE_TYPES.get(expr.name);
      if (primitive === undefined) {
        // `@effect` and `@handle` are handled at their application sites,
        // because their types depend on the argument's shape.
        if (
          expr.name === "@effect" || expr.name === "@effect.host" ||
          expr.name === "@handle"
        ) {
          return freshVar(level);
        }
        fail(
          "BLOT_UNKNOWN_PRIMITIVE",
          `\`${expr.name}\` is not a primitive.`,
          expr.span,
        );
      }
      return instantiate(primitive, level);
    }

    case "tag":
      return variant([[expr.name, UNIT]]);

    case "apply": {
      // A constructor applied to a payload is not a call: `#Progress 2` builds
      // `#Progress Int`, and typing it through a function would lose the tag.
      if (expr.fn.tag === "tag") {
        const payload = infer(expr.arg, context, level, row);
        return variant([[expr.fn.name, payload]]);
      }

      const special = inferSpecial(expr, context, level, row);
      if (special !== null) return special;

      const fnType = infer(expr.fn, context, level, row);
      const argType = infer(expr.arg, context, level, row);
      const result = freshVar(level);
      located(expr.span, () => {
        constrain(fnType, { tag: "fun", param: argType, effects: row, result });
      });
      return result;
    }

    case "field": {
      // A type value's namespace is compile-time, and the ordinary field rule
      // does not describe it: `Point` bridges to its storage, so `.new` is not
      // a field of the type and asking for one would be a false error. When
      // the target is a name bound to such a value and the name is a member,
      // the member decides. A member that is a closure has no type to read off
      // the value, so this stays silent rather than guessing.
      if (expr.target.tag === "var") {
        const bound = lookupValue(context.values, expr.target.name);
        if (bound !== undefined && bound.tag === "extended") {
          const member = bound.members.get(expr.name);
          if (member !== undefined) {
            const bridged = bridge(member);
            if (bridged === null) return freshVar(level);
            return bridged;
          }
        }
      }
      const target = infer(expr.target, context, level, row);
      const result = freshVar(level);
      located(expr.span, () => {
        constrain(target, record([[expr.name, result]]));
      });
      // Record what the target's whole field set is, if it is known. Lowering
      // cannot see it and cannot build the nominal without it. Deferred to the
      // end of checking, because a later use may add a field this one does not
      // mention.
      context.pending.push(() => {
        const fields = fieldsOf(target);
        if (fields !== null) context.shapes.set(expr, fields);
      });
      // A projection off the module parameter is a granted capability. Read
      // after checking, because the signature comes from how the program
      // *uses* it and at the projection nothing has used it yet.
      if (
        expr.target.tag === "var" &&
        expr.target.name === context.parameterName
      ) {
        context.pending.push(() => {
          const signature = arrowOf(result);
          if (signature !== null) context.grants.set(expr, signature);
        });
      }
      return result;
    }

    case "lambda": {
      const scope = childTypeEnv(context.types);
      const inner: Context = { ...context, types: scope };
      const param = bindPattern(expr.parameter, scope, level);
      // A fresh row per lambda is what makes the inferred effect minimal:
      // nothing becomes effectful because something else nearby was.
      const bodyRow = freshVar(level);
      const result = infer(expr.body, inner, level, bodyRow);
      return { tag: "fun", param, effects: bodyRow, result };
    }

    case "rec": {
      if (expr.lambda.tag !== "lambda") {
        fail("BLOT_TYPE_ERROR", "`rec` applies to a lambda.", expr.span);
      }
      return infer(expr.lambda, context, level, row);
    }

    case "comptime": {
      const value = requireComptime(
        expr.body,
        context,
        "A `comptime` expression",
      );
      const bridged = bridge(value);
      if (bridged !== null) return bridged;
      return infer(expr.body, context, level, row);
    }

    case "tuple":
      return tupleType(expr.elements.map((e) => infer(e, context, level, row)));

    case "array": {
      const element = freshVar(level);
      for (const item of expr.elements) {
        const itemType = infer(item.value, context, level, row);
        located(expr.span, () => {
          if (item.spread) constrain(itemType, { tag: "array", element });
          else constrain(itemType, element);
        });
      }
      return { tag: "array", element };
    }

    case "shape": {
      const fields = new Map<string, SimpleType>();
      const written = new Set<string>();
      for (const member of expr.members) {
        const memberType = infer(member.value, context, level, row);
        if (member.tag === "field") {
          if (written.has(member.name)) {
            fail(
              "BLOT_DUPLICATE_FIELD",
              `Field \`.${member.name}\` is written more than once in this shape.`,
              member.value.span,
            );
          }
          written.add(member.name);
          fields.set(member.name, memberType);
          continue;
        }
        // A spread contributes whatever the spread value holds, and the
        // backend has to copy those fields one by one — so record the set.
        context.pending.push(() => {
          const spread = fieldsOf(memberType);
          if (spread !== null) context.shapes.set(member.value, spread);
        });
        // A spread of a shape whose fields are not statically known cannot
        // contribute names. Saying so is better than inventing them.
        if (memberType.tag === "record") {
          for (const [name, inner] of memberType.fields) {
            fields.set(name, inner);
          }
        }
      }
      return record(fields);
    }

    case "if": {
      const result = freshVar(level);
      // `else if` is one flat chain of branches, so the knowledge accumulates:
      // branch `i` is inferred already knowing that branches `0..i-1` did not
      // fire, and the fallback knows that none of them did. `outer` is that
      // running scope.
      let outer = context.types;
      for (const branch of expr.branches) {
        const scoped: Context = { ...context, types: outer };
        const condition = infer(branch.condition, scoped, level, row);
        located(branch.condition.span, () => {
          constrain(condition, variant([["True", UNIT], ["False", UNIT]]));
        });
        const proof = narrowing(branch.condition, outer);
        const consequence = infer(
          branch.consequence,
          { ...context, types: proven(outer, proof, "taken") },
          level,
          row,
        );
        located(branch.consequence.span, () => constrain(consequence, result));
        outer = proven(outer, proof, "untaken");
      }
      if (expr.fallback !== null) {
        const inner: Context = { ...context, types: outer };
        const fallback = infer(expr.fallback, inner, level, row);
        located(expr.fallback.span, () => constrain(fallback, result));
      }
      return result;
    }

    case "case":
      return inferCase(expr, context, level, row);

    case "block": {
      const scope = childTypeEnv(context.types);
      const values = childEnv(context.values);
      const inner: Context = { ...context, types: scope, values };
      inferDeclarations(expr.declarations, inner, level, row);
      return infer(expr.result, inner, level, row);
    }
  }
}

/**
 * `@effect` and `@handle` depend on the shape of their arguments rather than on
 * a fixed scheme, so they are typed at the application site.
 */
function inferSpecial(
  expr: Expr & { tag: "apply" },
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType | null {
  let head = spine(expr);
  if (head === null) return null;
  const callee = head.callee;
  if (callee.tag !== "intrinsic") return null;

  if (
    (callee.name === "@effect" || callee.name === "@effect.host") &&
    head.args.length === 1
  ) {
    // An effect's identity comes from evaluating it: two effects that both
    // declare `.write` are still different effects.
    const value = comptime(expr, context);
    if (value !== null && value.tag === "effect") {
      const bridged = bridge(value);
      if (bridged !== null) return bridged;
    }
    return freshVar(level);
  }

  // A module is a function from its input record to its export record, and it
  // is checked once and shared. Typing the import is what lets a caller see
  // the module's exports instead of an opaque value.
  if (callee.name === "@import" && head.args.length >= 1) {
    const specifier = head.args[0];
    if (specifier.tag !== "text") return null;
    const moduleType = context.modules.get(specifier.value);
    if (moduleType === undefined) return null;
    let result = instantiate(scheme(moduleType, -1), level);
    for (const argument of head.args.slice(1)) {
      const argumentType = infer(argument, context, level, row);
      const applied = freshVar(level);
      const target = result;
      located(expr.span, () => {
        constrain(target, {
          tag: "fun",
          param: argumentType,
          effects: row,
          result: applied,
        });
      });
      result = applied;
    }
    return result;
  }

  if (callee.name === "@handle" && head.args.length === 1) {
    const parts = head.args[0];
    if (parts.tag !== "tuple" || parts.elements.length !== 3) {
      fail(
        "BLOT_TYPE_ERROR",
        "`@handle` takes `(effect, computation, handler)`.",
        expr.span,
      );
    }
    head = { callee: head.callee, args: [...parts.elements] };
  }

  if (callee.name === "@handle" && head.args.length === 3) {
    // `@handle` names the effect it discharges, so the row arithmetic is real:
    // everything the computation performs *except* that effect still has to be
    // handled somewhere, and flows on into the ambient row.
    const effect = comptime(head.args[0], context);
    if (effect === null || effect.tag !== "effect") {
      fail(
        "BLOT_TYPE_ERROR",
        "`@handle` takes the effect it discharges as its first argument.",
        head.args[0].span,
      );
    }
    const discharged = effectLabel(effect);
    let handlerExpression: Expr | undefined = head.args[2];
    if (handlerExpression.tag === "var") {
      handlerExpression = lookupLiteral(context.types, handlerExpression.name);
    }
    if (handlerExpression === undefined || handlerExpression.tag !== "shape") {
      fail(
        "BLOT_TYPE_ERROR",
        "A handler must be a statically known shape of clauses.",
        head.args[2].span,
      );
    }
    for (const member of handlerExpression.members) {
      if (member.tag !== "field" || member.name === "return") continue;
      const clause = member.value;
      let resume: Pattern | undefined;
      if (clause.tag === "lambda" && clause.parameter.tag === "tuple") {
        resume = clause.parameter.elements[1];
      }
      if (
        resume === undefined || resume.tag !== "name" ||
        resume.qualifier !== "affine"
      ) {
        fail(
          "BLOT_HANDLER_RESUME_NOT_AFFINE",
          `Handler clause \`.${member.name}\` must bind its continuation as \`?resume\`.`,
          clause.span,
        );
      }
    }

    const thunkRow = freshVar(level);
    const thunk = infer(head.args[1], context, level, row);
    const handler = infer(head.args[2], context, level, row);
    const computationResult = freshVar(level);
    const handledResult = freshVar(level);

    located(expr.span, () => {
      constrain(thunk, {
        tag: "fun",
        param: UNIT,
        effects: thunkRow,
        result: computationResult,
      });
      // A clause per operation, each taking `(argument, resume)`. Checking the
      // handler against the effect is what makes a typo in an operation name a
      // type error rather than a silent no-op at run time.
      for (const [name, signature] of effect.operations) {
        let bridged = bridge(signature);
        if (bridged !== null && bridged.tag === "forall") {
          bridged = instantiateForall(bridged, level);
        }
        if (bridged === null || bridged.tag !== "fun") continue;
        const clause = freshVar(level);
        constrain(handler, record([[name, clause]]));
        const continuation = {
          tag: "fun" as const,
          param: bridged.result,
          effects: row,
          result: handledResult,
        };
        constrain(clause, {
          tag: "fun",
          param: tupleType([bridged.param, continuation]),
          effects: row,
          result: handledResult,
        });
      }
      const handlerFields = fieldsOf(handler);
      if (handlerFields !== null && handlerFields.includes("return")) {
        const returnClause = freshVar(level);
        constrain(handler, record([["return", returnClause]]));
        constrain(returnClause, {
          tag: "fun",
          param: computationResult,
          effects: row,
          result: handledResult,
        });
      } else {
        constrain(computationResult, handledResult);
      }
    });

    // Whatever the computation performs beyond this effect is still owed.
    context.pending.push(() => {
      const remaining = rowLabels(thunkRow, new Set()).filter((label) => label !== discharged);
      if (remaining.length > 0) {
        located(expr.span, () => constrain(effects(remaining), row));
      }
    });
    return handledResult;
  }

  if (callee.name === "@satisfies" && head.args.length === 2) {
    const valueType = infer(head.args[0], context, level, row);
    const typeValue = comptime(head.args[1], context);
    if (typeValue === null) return null;
    const expected = bridge(typeValue);
    if (expected === null) {
      fail(
        "BLOT_TYPE_ERROR",
        "The second argument to `@satisfies` must evaluate to a type.",
        head.args[1].span,
      );
    }
    located(expr.span, () => constrain(valueType, expected));
    return valueType;
  }

  return null;
}

interface Spine {
  readonly callee: Expr;
  readonly args: readonly Expr[];
}

function spine(expr: Expr): Spine | null {
  const args: Expr[] = [];
  let current = expr;
  while (current.tag === "apply") {
    args.unshift(current.arg);
    current = current.fn;
  }
  if (args.length === 0) return null;
  return { callee: current, args };
}

/**
 * What one branch of an `if` proves about one name.
 *
 * Both types are computed, never represented: `taken` is the type `1`, not the
 * type `(1 | 2 | 3) & 1`. Nothing is written into the lattice, no `constrain`
 * call is made, and no variable bound is pushed — narrowing is a name shadow in
 * a child scope, exactly the mechanism `inferCase` already uses for an arm. That
 * is what keeps intersection out of the positive polarity and complement out of
 * both, so biunification stays where it was.
 */
interface Narrowing {
  readonly name: string;
  /** The type the name had before the branch, for recognising a no-op. */
  readonly before: SimpleType;
  readonly taken: SimpleType;
  readonly untaken: SimpleType;
}

/**
 * What `condition` proves, when the function it calls is a recognised comparison
 * of an integer against a compile-time integer.
 *
 * Nothing here knows what `==` is. `n == 1` has already become the ordinary
 * application `Eq.eq n 1`, and this reads the compile-time value bound to that
 * path — through `lookupComptime`, so a shadowed `Eq` is refused rather than
 * mistaken for the prelude's — and asks `recognise` what it computes.
 */
function narrowing(condition: Expr, scope: TypeEnv): Narrowing | null {
  if (condition.tag !== "apply") return null;
  if (condition.fn.tag !== "apply") return null;
  const path = namePath(condition.fn.fn);
  if (path === null) return null;
  const callee = comptimeAt(path, scope);
  if (callee === null) return null;
  const answers = recognise(callee);
  if (answers === null) return null;

  // The witness decides which side is the subject. One side must be a single
  // compile-time integer — not merely a ground type. `n == m` where `m`'s type
  // is `1 | 2` would let the untaken branch conclude `n ∉ {1, 2}`, but all the
  // condition said is that `n` differs from *this* `m`. A whole type is a sound
  // witness for the intersection and an unsound one for the complement, so
  // neither is taken unless the witness is one value.
  const left = condition.fn.arg;
  const right = condition.arg;
  const leftWitness = comptimeInt(left, scope);
  const rightWitness = comptimeInt(right, scope);
  if (leftWitness !== null && rightWitness !== null) return null;

  if (rightWitness !== null) {
    const subject = comparedName(left, scope);
    if (subject === null) return null;
    return proves(subject, answers, rightWitness);
  }
  if (leftWitness !== null) {
    const subject = comparedName(right, scope);
    if (subject === null) return null;
    // `1 < n` is `n > 1`. Mirroring the three-element ordering set is a
    // bijection, so mirroring before complementing and after agree.
    return proves(subject, mirror(answers), leftWitness);
  }
  return null;
}

function proves(
  subject: { readonly name: string; readonly type: SimpleType },
  answers: ReadonlySet<Ordering>,
  witness: bigint,
): Narrowing | null {
  const taken = intersect(subject.type, region(answers, witness));
  const untaken = intersect(
    subject.type,
    region(complement(answers), witness),
  );
  if (taken.tag !== "type" || untaken.tag !== "type") return null;
  return {
    name: subject.name,
    before: subject.type,
    taken: taken.type,
    untaken: untaken.type,
  };
}

/** The branch's scope, carrying what it proved. */
function proven(
  scope: TypeEnv,
  proof: Narrowing | null,
  side: "taken" | "untaken",
): TypeEnv {
  if (proof === null) return scope;
  let narrowed = proof.taken;
  if (side === "untaken") narrowed = proof.untaken;
  // An empty intersection means the branch cannot be reached. Reporting that is
  // a separate diagnostic; installing `⊥` here would instead make every use of
  // the name inside it check against nothing.
  if (narrowed.tag === "bottom") return scope;
  // Built once per branch, and only when it says something new: `constrain`
  // memoises on object identity, so a fresh copy of an unchanged type would
  // quietly defeat the cache.
  if (sameGround(narrowed, proof.before)) return scope;
  const inner = childTypeEnv(scope);
  inner.names.set(proof.name, narrowed);
  return inner;
}

/** A name whose type is already a ground set of integers — the `sig` case. */
function comparedName(
  expr: Expr,
  scope: TypeEnv,
): { readonly name: string; readonly type: SimpleType } | null {
  if (expr.tag !== "var") return null;
  const type = groundIntType(lookupType(scope, expr.name));
  if (type === null) return null;
  return { name: expr.name, type };
}

function groundIntType(typing: Typing | undefined): SimpleType | null {
  if (typing === undefined) return null;
  if (typing.tag === "scheme") return null;
  if (typing.tag === "range") {
    if (typing.domain !== "int") return null;
    return typing;
  }
  if (typing.tag === "union") {
    for (const member of typing.members) {
      if (member.tag !== "range") return null;
      if (member.domain !== "int") return null;
    }
    return typing;
  }
  return null;
}

/** `Eq.eq` as `["Eq", "eq"]`. Anything computed is not a path. */
function namePath(expr: Expr): readonly string[] | null {
  if (expr.tag === "var") return [expr.name];
  if (expr.tag !== "field") return null;
  const prefix = namePath(expr.target);
  if (prefix === null) return null;
  return [...prefix, expr.name];
}

function comptimeAt(
  path: readonly string[],
  scope: TypeEnv,
): Value | null {
  let value = lookupComptime(scope, path[0]);
  for (const name of path.slice(1)) {
    if (value === null) return null;
    if (value.tag !== "shape") return null;
    const found = value.fields.get(name);
    if (found === undefined) return null;
    value = found;
  }
  return value;
}

/**
 * A witness reached without running any user code.
 *
 * `-9` is `Num.negate 9`, an application, and evaluating it would mean calling
 * whatever `Num.negate` happens to name. So it is not a witness, and `if n == -9`
 * narrows nothing.
 */
function comptimeInt(expr: Expr, scope: TypeEnv): bigint | null {
  if (expr.tag === "int") return expr.value;
  const path = namePath(expr);
  if (path === null) return null;
  const value = comptimeAt(path, scope);
  if (value === null) return null;
  if (value.tag !== "int") return null;
  return value.value;
}

function sameGround(left: SimpleType, right: SimpleType): boolean {
  if (left.tag === "range" && right.tag === "range") {
    return left.domain === right.domain && left.low === right.low &&
      left.high === right.high;
  }
  if (left.tag === "union" && right.tag === "union") {
    if (left.members.length !== right.members.length) return false;
    return left.members.every((member, index) => sameGround(member, right.members[index]));
  }
  return false;
}

function inferCase(
  expr: Expr & { tag: "case" },
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType {
  const target = infer(expr.target, context, level, row);
  const result = freshVar(level);
  const accepted: AcceptedArm[] = [];

  // An arm that matches every value leaves the constructor set unbounded, but
  // not unknown: the refutable arms still say what their payloads carry.
  const open = expr.arms.some((arm) => irrefutable(arm.pattern));

  for (const arm of expr.arms) {
    const scope = childTypeEnv(context.types);
    const inner: Context = { ...context, types: scope };
    const armType = bindPattern(arm.pattern, scope, level);

    if (arm.pattern.tag === "name") {
      // An irrefutable name matches every value, so it *is* the scrutinee.
      located(arm.pattern.span, () => constrain(target, armType));
    }
    if (!irrefutable(arm.pattern)) {
      accepted.push({ pattern: arm.pattern, accepted: armType });
      // Narrowing: inside the arm, a matched name is known to have the arm's
      // shape. This is what "branches prove stuff" amounts to over a union
      // lattice — refinement, not dependent types.
      if (expr.target.tag === "var") scope.names.set(expr.target.name, armType);
    }

    const body = infer(arm.body, inner, level, row);
    located(arm.body.span, () => constrain(body, result));
  }

  // The scrutinee must be covered by the arms taken together. A variant with a
  // case no arm mentions is caught here rather than at runtime. When an arm is
  // irrefutable the requirement is open instead of absent — dropping it is what
  // left `case c of #Some v => v, _ => 0 end` with `v` unrelated to `c`.
  const covered = mergeAccepted(accepted, open);
  if (covered !== null) {
    located(expr.target.span, () => constrain(target, covered));
  }
  // A literal set is covered by membership rather than by subtyping, so it is
  // checked instead of constrained. `mergeAccepted` gives up the moment an arm
  // is not a constructor, which left `case n of 1 => "one" end` over `1 | 2 | 3`
  // with no requirement at all — accepted here and trapping at runtime.
  //
  // Constraining `target` against the union of the literal arms would pass this
  // program's gate and be wrong: with no `sig` the target is a bare variable,
  // and the constraint would pin it to whatever the arms happen to list rather
  // than reporting what they miss. Literal arms stay non-constraining.
  if (!open) {
    const armTypes = accepted.map((arm) => arm.accepted);
    const missing = uncovered(target, armTypes);
    if (missing !== null && missing.length > 0) {
      fail(
        "BLOT_INCOMPLETE_CASE",
        `No arm covers \`${showLiterals(missing)}\`.`,
        expr.target.span,
      );
    }
    // A scrutinee with an open end holds infinitely many values, so literal
    // arms can never exhaust it. `uncovered` returns nothing to list, and
    // reading that as "covered" is what let this trap at run time instead.
    if (missing === null && armTypes.length > 0 && scalarArms(armTypes)) {
      const scrutinee = groundScalar(target);
      if (scrutinee !== null && unlistable(scrutinee)) {
        fail(
          "BLOT_INCOMPLETE_CASE",
          `\`${showType(scrutinee)}\` has more values than these arms can cover. ` +
            "Add the arms it is missing, or a `_` arm — `@panic` says why " +
            "reaching it is impossible.",
          expr.target.span,
        );
      }
    }
  }
  // Recorded after the arms, not before: the scrutinee's constructor set is
  // what the arms proved it must be, and before them there is nothing to read.
  const cases = casesOf(target);
  if (cases !== null) context.variants.set(expr, cases);
  return result;
}

/**
 * The field set of a record type, digging through a variable's bounds.
 *
 * A variable's lower bounds are what flowed into it, and a record among them is
 * the shape the value actually has. Several disagreeing records mean the field
 * set is not known here, and saying so beats picking one.
 */
function fieldsOf(type: SimpleType): readonly string[] | null {
  const found = new Set<string>();
  let sawRecord = false;

  const walk = (current: SimpleType, seen: Set<number>): void => {
    if (current.tag === "record") {
      sawRecord = true;
      for (const name of current.fields.keys()) found.add(name);
      return;
    }
    if (current.tag !== "var" || seen.has(current.id)) return;
    seen.add(current.id);
    // Both directions: a value's fields are what flowed in, and a parameter's
    // are what the body demanded. `(&p) => p.x + p.y` pins `p` from above.
    for (const bound of [...current.lower, ...current.upper]) walk(bound, seen);
  };

  walk(type, new Set());
  return sawRecord ? [...found] : null;
}

/**
 * The constructor set of a variant type, with each tag's arity.
 *
 * Arity matters to the backend and to nothing else: Core constructors declare
 * their fields, and `#Ready` with no payload cannot share a field list with
 * `#Busy n`.
 */
function casesOf(type: SimpleType): readonly VariantCase[] | null {
  const found = new Map<string, boolean>();
  let sawVariant = false;

  const walk = (current: SimpleType, seen: Set<number>): void => {
    if (current.tag === "variant") {
      // An open variant names the constructors one `case` read, not the whole
      // set. The backend needs the whole set, so this is not it.
      if (current.open) return;
      sawVariant = true;
      for (const [name, payload] of current.cases) {
        found.set(name, found.get(name) === true || payload.tag !== "unit");
      }
      return;
    }
    if (current.tag !== "var" || seen.has(current.id)) return;
    seen.add(current.id);
    for (const bound of [...current.lower, ...current.upper]) walk(bound, seen);
  };

  walk(type, new Set());
  if (!sawVariant) return null;
  return [...found].map(([name, payload]) => ({ name, payload }));
}

/** The concrete effect labels a row carries. */
function rowLabels(type: SimpleType, seen: Set<number>): string[] {
  if (type.tag === "effects") return [...type.labels];
  if (type.tag !== "var" || seen.has(type.id)) return [];
  seen.add(type.id);
  return type.lower.flatMap((bound) => rowLabels(bound, seen));
}

/** A refutable arm's pattern together with what it accepts. */
interface AcceptedArm {
  readonly pattern: Pattern;
  readonly accepted: SimpleType;
}

/**
 * Arms of one `case` accept the union of their patterns.
 *
 * `open` is set when some arm matched everything: the constructors named here
 * then constrain their payloads without closing the set. An arm that is not a
 * constructor — a literal, a shape — is not a union at all, and saying nothing
 * beats inventing a coverage it does not have.
 *
 * One constructor may have several arms, and only the first that can match it
 * runs. A total payload pattern settles the constructor: it cannot fail, so
 * every later arm for that constructor is unreachable, which is the same rule
 * the backend lowers by. A literal payload is a guard rather than a
 * requirement, so it constrains nothing on its own.
 */
/** Every arm matches a single scalar literal — nothing structural. */
function scalarArms(arms: readonly SimpleType[]): boolean {
  return arms.every((arm) => arm.tag === "range");
}

/** The scrutinee as a scalar set, through a variable's bounds if need be. */
function groundScalar(type: SimpleType): SimpleType | null {
  if (type.tag === "range") return type;
  if (type.tag === "union") {
    if (type.members.every((member) => member.tag === "range")) return type;
    return null;
  }
  if (type.tag === "var") {
    for (const bound of type.upper) {
      const found = groundScalar(bound);
      if (found !== null) return found;
    }
  }
  return null;
}

function mergeAccepted(
  accepted: readonly AcceptedArm[],
  open: boolean,
): SimpleType | null {
  const cases = new Map<string, SimpleType>();
  const settled = new Set<string>();
  for (const arm of accepted) {
    if (arm.accepted.tag !== "variant") return null;
    const total = arm.pattern.tag === "constructor" &&
      (arm.pattern.payload === null || totalPattern(arm.pattern.payload));
    for (const [name, payload] of arm.accepted.cases) {
      if (settled.has(name)) continue;
      if (total) {
        cases.set(name, payload);
        settled.add(name);
        continue;
      }
      if (!cases.has(name)) cases.set(name, TOP);
    }
  }
  if (cases.size === 0) return null;
  if (open) return openVariant(cases);
  return variant(cases);
}

/** Does this pattern match every value of the type it is written against? */
function totalPattern(pattern: Pattern): boolean {
  switch (pattern.tag) {
    case "wildcard":
    case "name":
    case "unit":
      return true;
    case "tuple":
      return pattern.elements.every(totalPattern);
    case "shape":
      return pattern.fields.every((field) => totalPattern(field.pattern));
    default:
      return false;
  }
}

function irrefutable(pattern: Pattern): boolean {
  return pattern.tag === "wildcard" || pattern.tag === "name";
}

/** Types a pattern and binds its names. Returns what the pattern accepts. */
function bindPattern(
  pattern: Pattern,
  scope: TypeEnv,
  level: Level,
): SimpleType {
  switch (pattern.tag) {
    case "wildcard":
      return freshVar(level);
    case "name": {
      const type = freshVar(level);
      scope.names.set(pattern.name, type);
      return type;
    }
    case "int":
      return intLiteral(pattern.value);
    case "text":
      return textLiteral(pattern.value);
    case "unit":
      return UNIT;
    case "tuple":
      return tupleType(
        pattern.elements.map((p) => bindPattern(p, scope, level)),
      );
    case "array": {
      const element = freshVar(level);
      for (const inner of pattern.elements) {
        constrain(element, bindPattern(inner, scope, level));
      }
      return { tag: "array", element };
    }
    case "constructor": {
      const payload = pattern.payload === null ? UNIT : bindPattern(pattern.payload, scope, level);
      return variant([[pattern.name, payload]]);
    }
    case "shape":
      return record(
        pattern.fields.map((field) =>
          [field.name, bindPattern(field.pattern, scope, level)] as const
        ),
      );
  }
}

function inferDeclarations(
  declarations: readonly Decl[],
  context: Context,
  level: Level,
  row: SimpleType,
): void {
  let pendingSig:
    | { name: string; type: SimpleType; span: Span }
    | null = null;

  for (const declaration of declarations) {
    if (pendingSig !== null) {
      const adjacent = declaration.tag === "binding" &&
        declaration.kind !== "sig" &&
        declaration.pattern.tag === "name" &&
        declaration.pattern.name === pendingSig.name;
      if (!adjacent) {
        fail(
          "BLOT_BAD_SIG",
          `The signature for \`${pendingSig.name}\` must be immediately followed by that binding.`,
          pendingSig.span,
        );
      }
    }

    if (declaration.tag === "open") {
      // Opening is the field rule applied once per resulting binding rather
      // than a new typing rule. The names come from the compile-time value
      // because that is the only place the set of them is known; the types
      // come from constraining the inferred record, because a closure has no
      // type to read off its value.
      const value = comptime(declaration.value, context);
      if (value === null || value.tag !== "shape") {
        fail(
          "BLOT_CANNOT_OPEN",
          "`open` spreads the fields of a compile-time record into scope.",
          declaration.span,
        );
      }
      const bindings = resolveOpenBindings(
        value.fields,
        declaration.mappings,
        declaration.span,
      );
      context.opens.set(
        declaration.value,
        new Map(bindings.map((binding) => [binding.target, binding.value])),
      );
      const target = infer(declaration.value, context, level, row);
      for (const binding of bindings) {
        context.values.names.set(binding.target, binding.value);
        const field = freshVar(level);
        located(declaration.span, () => {
          constrain(target, record([[binding.source, field]]));
        });
        // Quantified below ground level, for the reason the module scope is:
        // these variables are already at level 0, and generalizing at 0 would
        // make every use share them — `fold` used once on text could then
        // never be used on integers.
        context.types.names.set(binding.target, scheme(field, -1));
        recordComptimeBinding(context.types, binding.target, binding.value);
      }
      continue;
    }
    if (declaration.tag === "shadow") {
      const previous = lookupType(context.types, declaration.name);
      if (previous === undefined) {
        fail(
          "BLOT_UNBOUND",
          `\`${declaration.name} := ...\` cannot shadow a name that is not in scope.`,
          declaration.span,
        );
      }
      // Same as a binding: evaluate first, name what it produced, and let the
      // *named* value be what gets bridged. Bridging first would mint the
      // effect's label from the placeholder name, and the rename afterwards
      // would come too late to matter.
      const named = namedComptime(declaration.name, declaration.value, context);
      let bridged: SimpleType | null = null;
      if (named !== null) bridged = bridge(named);
      let inferred: Typing;
      if (bridged === null) {
        inferred = generalize(declaration.value, context, level, row);
      } else {
        inferred = bridged;
      }
      const previousType = stableRebindingType(
        instantiate(previous, level + 1),
      );
      const inferredType = stableRebindingType(
        instantiate(inferred, level + 1),
      );
      try {
        constrain(previousType, inferredType);
        constrain(inferredType, previousType);
      } catch (error) {
        if (!(error instanceof TypeError_)) throw error;
        fail(
          "BLOT_TYPE_ERROR",
          `\`${declaration.name} := ...\` must preserve ${showType(previousType)}, found ${
            showType(inferredType)
          }. Use \`let ${declaration.name} = ...;\` to shadow it with a different type.`,
          declaration.span,
        );
      }
      if (named !== null) {
        context.values.names.set(declaration.name, named);
        context.comptimeValues.set(declaration.value, named);
      }
      if (previous.tag === "scheme") {
        context.types.names.set(
          declaration.name,
          scheme(stableRebindingType(previous.body), previous.level),
        );
      } else {
        context.types.names.set(
          declaration.name,
          stableRebindingType(previous),
        );
      }
      // A rebinding whose value is not known at compile time erases the one the
      // name had. `stableRebindingType` can hand back the very type it was
      // given, so the `Typing` pairing alone would not always notice a `:=` in
      // the same scope as the binding it shadows.
      context.types.comptime.delete(declaration.name);
      if (named !== null) {
        recordComptimeBinding(context.types, declaration.name, named);
      }
      continue;
    }

    if (declaration.kind === "sig") {
      if (declaration.pattern.tag !== "name") {
        fail("BLOT_BAD_SIG", "`sig` names a single binding.", declaration.span);
      }
      const value = comptime(declaration.value, context);
      if (value === null) {
        fail(
          "BLOT_SIG_NOT_COMPTIME",
          "A `sig` must evaluate at compile time.",
          declaration.span,
        );
      }
      const bridged = bridge(value);
      if (bridged === null) {
        // Naming what it got matters here: the commonest mistake is reaching
        // for a namespace whose name reads like a type — `Text` is the record
        // of text functions and `Str` is the type — and the old message left
        // the reader to guess which of the two they had.
        fail(
          "BLOT_SIG_NOT_A_TYPE",
          `A \`sig\` must evaluate to a type; this one evaluates to ${show(value)}.`,
          declaration.span,
        );
      }
      pendingSig = {
        name: declaration.pattern.name,
        type: bridged,
        span: declaration.span,
      };
      continue;
    }

    // A `const` whose value is a type *is* its type. Bridging beats inferring
    // here: `const Console = @effect {...}` has no inferable structure, but its
    // value knows exactly which operations exist and which row they carry.
    let type: Typing | null = null;
    let signature: SimpleType | null = null;
    if (
      pendingSig !== null && declaration.pattern.tag === "name" &&
      pendingSig.name === declaration.pattern.name
    ) {
      signature = pendingSig.type;
    }
    let bound: Value | null = null;
    if (declaration.kind === "const") {
      // Through `bind`, not `evaluate`: a `const` may be `rec`, and `rec` only
      // means anything when it knows the name it is being bound to.
      const raw = requireComptimeBinding(
        declaration.pattern,
        declaration.value,
        context,
      );
      // `@effect` cannot know what it will be called, so the binding names it.
      // The identity is preserved: this is a rename, not a second effect.
      const value = raw !== null && raw.tag === "effect" && raw.name === "Effect" &&
          declaration.pattern.tag === "name"
        ? { ...raw, name: declaration.pattern.name }
        : raw;
      if (value !== null) {
        recordComptime(declaration.pattern, value, context);
        context.comptimeValues.set(declaration.value, value);
        bound = value;
        const bridged = bridge(value);
        if (bridged !== null) type = bridged;
      }
    }

    if (type === null) {
      if (signature !== null && declaration.value.tag === "lambda") {
        type = checkAgainst(
          declaration.value,
          signature,
          context,
          level,
          row,
        );
      } else {
        type = declaration.value.tag === "rec" && declaration.pattern.tag === "name"
          ? generalizeRec(
            declaration.pattern.name,
            declaration.value,
            context,
            level,
            row,
          )
          : generalize(declaration.value, context, level, row);
      }
    }

    if (
      pendingSig !== null && declaration.pattern.tag === "name" &&
      pendingSig.name === declaration.pattern.name
    ) {
      const expected = pendingSig.type;
      located(declaration.span, () => {
        constrain(instantiate(type as Typing, level), expected);
      });
      type = expected;
      pendingSig = null;
    }

    bindDeclaration(declaration.pattern, type, context, level);
    if (bound !== null && declaration.pattern.tag === "name") {
      recordComptimeBinding(context.types, declaration.pattern.name, bound);
    }
    if (
      declaration.pattern.tag === "name" &&
      (declaration.value.tag === "shape" ||
        declaration.value.tag === "lambda")
    ) {
      context.types.literals.set(
        declaration.pattern.name,
        declaration.value,
      );
    }
  }

  if (pendingSig !== null) {
    fail(
      "BLOT_BAD_SIG",
      `The signature for \`${pendingSig.name}\` has no adjacent binding.`,
      pendingSig.span,
    );
  }
}

/** Widens singleton literals so rebinding preserves their domain. */
function stableRebindingType(
  type: SimpleType,
): SimpleType {
  if (type.tag === "range") {
    if (type.domain === "int") return INT;
    return TEXT;
  }
  if (type.tag === "array") {
    return { tag: "array", element: stableRebindingType(type.element) };
  }
  if (type.tag === "record") {
    return record(
      [...type.fields].map(([name, member]) => [
        name,
        stableRebindingType(member),
      ]),
    );
  }
  if (type.tag === "variant") {
    const cases = [...type.cases].map((
      [name, payload],
    ) => [name, stableRebindingType(payload)] as const);
    if (type.open) return openVariant(cases);
    return variant(cases);
  }
  if (type.tag === "fun") {
    return {
      tag: "fun",
      param: stableRebindingType(type.param),
      effects: stableRebindingType(type.effects),
      result: stableRebindingType(type.result),
    };
  }
  if (type.tag === "forall") {
    return {
      tag: "forall",
      variables: type.variables,
      body: stableRebindingType(type.body),
    };
  }
  if (type.tag === "union") {
    return {
      tag: "union",
      members: type.members.map(stableRebindingType),
    };
  }
  return type;
}

function checkAgainst(
  expr: Expr,
  expected: SimpleType,
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType {
  if (expr.tag !== "lambda" || expected.tag !== "fun") {
    const inferred = infer(expr, context, level + 1, row);
    located(expr.span, () => constrain(inferred, expected));
    return expected;
  }

  const scope = childTypeEnv(context.types);
  const inner: Context = { ...context, types: scope };
  bindPatternAgainst(expr.parameter, expected.param, scope, level + 1);
  const bodyRow = freshVar(level + 1);
  checkAgainst(
    expr.body,
    expected.result,
    inner,
    level + 1,
    bodyRow,
  );
  located(expr.span, () => constrain(bodyRow, expected.effects));
  return expected;
}

function bindPatternAgainst(
  pattern: Pattern,
  expected: SimpleType,
  scope: TypeEnv,
  level: Level,
): void {
  if (pattern.tag === "name") {
    scope.names.set(pattern.name, expected);
    return;
  }
  const accepted = bindPattern(pattern, scope, level);
  located(pattern.span, () => constrain(expected, accepted));
}

function bindDeclaration(
  pattern: Pattern,
  type: Typing,
  context: Context,
  level: Level,
): void {
  if (pattern.tag === "name") {
    context.types.names.set(pattern.name, type);
    return;
  }
  // A destructuring binding types its parts by constraining the whole against
  // the shape the pattern requires.
  const scope = context.types;
  const required = bindPattern(pattern, scope, level);
  const whole = instantiate(type, level);
  located(pattern.span, () => constrain(whole, required));
  recordPatternShapes(pattern, whole, context);
}

/** A function type, dug out of whatever bounds carry it. */
function arrowOf(
  type: SimpleType,
  seen = new Set<number>(),
): GrantSignature | null {
  if (type.tag === "fun") {
    return { parameter: type.param, result: type.result };
  }
  if (type.tag !== "var" || seen.has(type.id)) return null;
  seen.add(type.id);
  for (const bound of [...type.upper, ...type.lower]) {
    const found = arrowOf(bound, seen);
    if (found !== null) return found;
  }
  return null;
}

/** What the value actually carries, wherever a shape pattern reads part of it. */
function recordPatternShapes(
  pattern: Pattern,
  type: SimpleType,
  context: Context,
): void {
  if (pattern.tag !== "shape") return;
  context.pending.push(() => {
    const fields = fieldsOf(type);
    if (fields !== null) context.patternShapes.set(pattern, fields);
  });
}

/** `let`-polymorphism: infer one level deeper, then quantify what stayed there. */
function generalize(
  expr: Expr,
  context: Context,
  level: Level,
  row: SimpleType,
): Typing {
  const inner = infer(expr, context, level + 1, row);
  return scheme(inner, level);
}

/**
 * `rec` makes a binding's own name visible inside its lambda, so the name has to
 * be in scope before the body is inferred. It is bound monomorphically: a
 * recursive call sees one type, and generalization happens once the body is
 * known.
 */
function generalizeRec(
  name: string,
  expr: Expr & { tag: "rec" },
  context: Context,
  level: Level,
  row: SimpleType,
): Typing {
  const scope = childTypeEnv(context.types);
  const placeholder = freshVar(level + 1);
  scope.names.set(name, placeholder);
  const inner = infer(
    expr.lambda,
    { ...context, types: scope },
    level + 1,
    row,
  );
  located(expr.span, () => constrain(inner, placeholder));
  return scheme(inner, level);
}

/** Evaluates a shadow's value and names the effect it may have produced. */
function namedComptime(
  name: string,
  expr: Expr,
  context: Context,
): ReturnType<typeof run> | null {
  return nameEffect(name, comptime(expr, context));
}

/**
 * `@effect` cannot know what it will be called, so the binding names it. The
 * identity is preserved: this is a rename, not a second effect.
 */
function nameEffect(
  name: string,
  value: ReturnType<typeof run> | null,
): ReturnType<typeof run> | null {
  if (value === null) return null;
  if (value.tag !== "effect" || value.name !== "Effect") return value;
  return { ...value, name };
}

function recordComptime(
  pattern: Pattern,
  value: ReturnType<typeof run>,
  context: Context,
): void {
  if (pattern.tag === "name") {
    context.values.names.set(pattern.name, value);
    return;
  }
  if (pattern.tag === "shape" && value.tag === "shape") {
    for (const field of pattern.fields) {
      const member = value.fields.get(field.name);
      if (member !== undefined) recordComptime(field.pattern, member, context);
    }
  }
}

export interface Checked {
  readonly type: SimpleType;
  readonly effects: SimpleType;
  /**
   * What each `open` brought into scope.
   *
   * The backend inlines an imported module into the *importer's* scope, so a
   * dependency's own `open` would otherwise install nothing there. The names
   * are compile-time, and inference already had to compute them, so they
   * travel with the rest of the facts rather than being recomputed.
   */
  readonly opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>;
  /**
   * Compile-time declaration values keyed by the expression that produced
   * them. Local bindings do not live in the module's final value environment,
   * but lowering still needs their identities while traversing a residual
   * block.
   */
  readonly comptimeValues: ReadonlyMap<Expr, Value>;
  /**
   * What inference learned that lowering needs.
   *
   * gpufuck has no records: they become nominal declarations, and a nominal
   * needs the *whole* field set. `p.x` alone does not say what else `p` has —
   * inference does, so it writes it down here rather than making the backend
   * re-derive it. Same for the constructor set behind a `case`.
   */
  readonly shapes: ReadonlyMap<Expr, readonly string[]>;
  readonly variants: ReadonlyMap<Expr, readonly VariantCase[]>;
  /**
   * The field set of the *value* a shape pattern destructures.
   *
   * blot has width subtyping, so `let { .x; } = point;` names fewer fields than
   * the value has. Core records are nominal, so the backend needs the value's
   * set rather than the pattern's — the pattern says what is wanted, not what
   * arrives.
   */
  readonly patternShapes: ReadonlyMap<Pattern, readonly string[]>;
  /**
   * The type of each projection off the entry module's parameter.
   *
   * The parameter is the program's whole authority, and at the WebAssembly
   * boundary that authority *is* the module's imports — so each field the
   * program reaches for becomes a declared host operation, and inference is
   * what knows its signature.
   */
  readonly grants: ReadonlyMap<Expr, GrantSignature>;
}

/** A granted capability's shape, as the boundary needs it. */
export interface GrantSignature {
  readonly parameter: SimpleType;
  readonly result: SimpleType;
}

/** One constructor of a union, and whether it carries a payload. */
export interface VariantCase {
  readonly name: string;
  readonly payload: boolean;
}

export function checkModule(
  module: Module,
  values: ValueEnv,
  imports: Imports,
  prelude: ReadonlyMap<string, SimpleType> | null,
  modules: ReadonlyMap<string, SimpleType> = new Map(),
): Checked {
  const types = childTypeEnv(null);
  if (prelude !== null) {
    // Quantified below ground level: the prelude's exports were already
    // instantiated once when its result record was built, which left their
    // variables at level 0. Re-generalizing at 0 would make every use share
    // them, so `fold` used once on text could never be used on integers.
    for (const [name, type] of prelude) types.names.set(name, scheme(type, -1));
  }
  const shapes = new Map<Expr, readonly string[]>();
  const variants = new Map<Expr, readonly VariantCase[]>();
  const patternShapes = new Map<Pattern, readonly string[]>();
  const grants = new Map<Expr, GrantSignature>();
  const opens = new Map<Expr, ReadonlyMap<string, Value>>();
  const comptimeValues = new Map<Expr, Value>();
  const pending: (() => void)[] = [];
  const context: Context = {
    opens,
    comptimeValues,
    shapes,
    variants,
    patternShapes,
    grants,
    parameterName: module.parameter !== null && module.parameter.tag === "name"
      ? module.parameter.name
      : null,
    pending,
    types,
    values,
    imports,
    modules,
  };
  const level = 0;
  const row = freshVar(level);

  if (module.parameter !== null) {
    // The entry module's parameter is the program's whole authority, and its
    // shape is whatever the program actually reaches for — inference discovers
    // the capability requirement rather than the program declaring it.
    bindPattern(module.parameter, types, level);
  }

  inferDeclarations(module.declarations, context, level, row);
  const result = infer(module.result, context, level, row);
  // Every constraint has been seen by now, so a field set read here is the
  // whole one rather than whatever the first projection happened to mention.
  for (const read of pending) read();
  return {
    type: result,
    effects: row,
    opens,
    comptimeValues,
    shapes,
    variants,
    patternShapes,
    grants,
  };
}

export { effects, PRIMITIVE_TYPES };
