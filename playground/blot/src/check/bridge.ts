// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Comptime value -> inference type.
//
// This function is what "types are values" costs and what it buys. A `sig` is
// an ordinary expression: it is evaluated by the same evaluator that runs the
// program, and whatever it produces has to become a lattice element before it
// can constrain anything. There is no type-level sublanguage to translate from,
// only values.
//
// Not every value is a type. A closure is not — its type has to be inferred
// from its body, not read off the value — so bridging returns `null` and the
// caller falls back to inference. Returning `null` rather than `⊤` matters:
// silently widening to "anything" would turn a missing case into a passing
// check.

import { show, type Value } from "../comptime/value.ts";
import {
  effects as effectRow,
  freshRigid,
  fun,
  INT,
  intLiteral,
  record,
  type SimpleType,
  TEXT,
  textLiteral,
  TOP,
  union,
  UNIT,
  variant,
} from "./type.ts";

/** A stable label for an effect, so two effects with one operation name differ. */
export function effectLabel(value: Value & { tag: "effect" }): string {
  return `${value.name}#${value.id}`;
}

/**
 * Labels of effects the host implements.
 *
 * A host effect's row is the program's declared interface — its operations
 * become WebAssembly imports — so it is allowed to reach the module boundary
 * where an ordinary effect nothing handles is an error. Effect ids are globally
 * unique, so one registry is enough.
 */
const hostLabels = new Set<string>();

export function isHostEffect(label: string): boolean {
  return hostLabels.has(label);
}

export function bridge(value: Value): SimpleType | null {
  return bridgeValue(value, new Map());
}

function bridgeValue(
  value: Value,
  variables: ReadonlyMap<number, SimpleType>,
): SimpleType | null {
  switch (value.tag) {
    case "int":
      return intLiteral(value.value);
    case "text":
      return textLiteral(value.value);
    case "unit":
      return UNIT;
    case "unbounded":
      return TOP;

    case "range": {
      const low = value.low.tag === "unbounded" ? null : scalar(value.low);
      const high = value.high.tag === "unbounded" ? null : scalar(value.high);
      const domain = value.domain ?? domainOf(value.low) ??
        domainOf(value.high);
      if (domain === undefined || domain === null) return null;
      return { tag: "range", domain, low, high };
    }

    case "arrow": {
      const domain = bridgeValue(value.domain, variables);
      const codomain = bridgeValue(value.codomain, variables);
      if (domain === null || codomain === null) return null;
      // A written arrow says nothing about effects, and inference is what
      // supplies the row. `⊤` here would be a lie in the other direction, so
      // the row is left open by using the pure row: a `sig` constrains what the
      // function accepts and returns, not what it performs.
      return fun(domain, codomain, effectRow([]));
    }

    case "union": {
      const members: SimpleType[] = [];
      const cases = new Map<string, SimpleType>();
      for (const member of value.members) {
        if (member.tag === "tag") {
          const payload = member.payload === null ? UNIT : bridgeValue(member.payload, variables);
          if (payload === null) return null;
          cases.set(member.name, payload);
          continue;
        }
        const bridged = bridgeValue(member, variables);
        if (bridged === null) return null;
        members.push(bridged);
      }
      if (cases.size > 0) members.push(variant(cases));
      return union(members);
    }

    case "tag": {
      const payload = value.payload === null ? UNIT : bridgeValue(value.payload, variables);
      if (payload === null) return null;
      return variant([[value.name, payload]]);
    }

    case "shape": {
      const fields: [string, SimpleType][] = [];
      for (const [name, member] of value.fields) {
        const bridged = bridgeValue(member, variables);
        if (bridged === null) return null;
        fields.push([name, bridged]);
      }
      return record(fields);
    }

    case "array": {
      const elements = value.elements.map((element) => bridgeValue(element, variables));
      if (elements.some((element) => element === null)) return null;
      return { tag: "array", element: union(elements as SimpleType[]) };
    }

    // Reaching into an effect names an operation, and performing it is an
    // ordinary call — so an effect's type is a record of functions whose rows
    // carry that effect. This is the whole mechanism behind effect inference.
    case "effect": {
      const label = effectLabel(value);
      if (value.host) hostLabels.add(label);
      const operations: [string, SimpleType][] = [];
      for (const [name, signature] of value.operations) {
        const bridged = bridgeValue(signature, variables);
        if (bridged === null) return null;
        if (bridged.tag === "forall" && bridged.body.tag === "fun") {
          operations.push([
            name,
            {
              ...bridged,
              body: fun(
                bridged.body.param,
                bridged.body.result,
                effectRow([label]),
              ),
            },
          ]);
          continue;
        }
        if (bridged.tag !== "fun") return null;
        operations.push([
          name,
          fun(bridged.param, bridged.result, effectRow([label])),
        ]);
      }
      return record(operations);
    }

    // Transparent: a struct's type is its storage. The members it carries are
    // a compile-time namespace and have no business in the lattice.
    case "extended":
      return bridgeValue(value.inner, variables);

    case "type-variable": {
      const variable = variables.get(value.id);
      if (variable === undefined) return null;
      return variable;
    }

    case "forall": {
      const variable = freshRigid();
      const innerVariables = new Map(variables);
      innerVariables.set(value.variable, variable);
      const body = bridgeValue(value.body, innerVariables);
      if (body === null) return null;
      return { tag: "forall", variables: [variable.id], body };
    }

    case "sealed":
      // A sealed type is identified by its name and its carrier, so the
      // opaque name has to carry both — otherwise `List I32` and `List Str`
      // would bridge to the same invariant type.
      return { tag: "opaque", name: `${value.name}#${show(value.inner)}` };

    // A closure's type comes from its body, not from the value.
    default:
      return null;
  }
}

function scalar(value: Value): bigint | string | null {
  if (value.tag === "int") return value.value;
  if (value.tag === "text") return value.value;
  return null;
}

function domainOf(value: Value): "int" | "text" | null {
  if (value.tag === "int") return "int";
  if (value.tag === "text") return "text";
  return null;
}

export { INT, TEXT };
