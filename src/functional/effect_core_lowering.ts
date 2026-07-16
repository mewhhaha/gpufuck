import { FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, FunctionalBinaryOperator } from "./abi.ts";
import type {
  FunctionalEffectCoreExpression,
  LoweredFunctionalEffectCoreModule,
} from "./effect_core_contract.ts";
import {
  operationKey,
  type PreparedEffectCore,
  type PreparedOperation,
} from "./effect_core_encoding.ts";
import {
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_INIT_TYPE_NAME,
  type FunctionalHostScalarType,
} from "./host_contract.ts";
import {
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
  surface,
} from "./surface_builder.ts";

interface VerifiedEffectCoreShape {
  readonly type: FunctionalHostScalarType;
  readonly effects: readonly string[];
}

export function lowerPreparedEffectCore(
  prepared: PreparedEffectCore,
  verification: VerifiedEffectCoreShape,
): LoweredFunctionalEffectCoreModule {
  const lowering = new EffectCoreLowering(prepared);
  const resultName = "$FunctionalEffectResult";
  let body = lowering.lower(prepared.module.expression, {
    kind: "lambda",
    parameter: resultName,
    body: surface.name(resultName),
  }, new Map());
  const parameters: string[] = [];
  if (prepared.hostCapabilities.length !== 0) {
    parameters.push("$FunctionalInit");
    const binders: string[] = [];
    let fieldIndex = 0;
    for (const capability of prepared.hostCapabilities) {
      for (const _field of capability.fields) {
        binders.push(`$FunctionalHostField${fieldIndex}`);
        fieldIndex += 1;
      }
    }
    body = {
      kind: "case",
      value: surface.name("$FunctionalInit"),
      arms: [{ constructor: FUNCTIONAL_INIT_CONSTRUCTOR_NAME, binders, body }],
    };
  }
  const entry: FunctionalSurfaceDefinition = {
    name: prepared.module.entryName,
    parameters,
    annotation: parameters.length === 0 ? verification.type : {
      kind: "function",
      parameter: { kind: "named", name: FUNCTIONAL_INIT_TYPE_NAME, arguments: [] },
      result: verification.type,
    },
    body,
  };
  return Object.freeze({
    definitions: Object.freeze([
      ...prepared.module.definitions,
      ...lowering.handlerDefinitions,
      entry,
    ]),
    typeDeclarations: Object.freeze([...prepared.module.typeDeclarations]),
    hostCapabilities: prepared.hostCapabilities,
    entryName: prepared.module.entryName,
    sourceByteLength: prepared.module.sourceByteLength,
    computationType: Object.freeze({
      value: verification.type,
      effects: verification.effects,
    }),
    resultType: Object.freeze({ value: verification.type, effects: Object.freeze([]) }),
  });
}

class EffectCoreLowering {
  readonly handlerDefinitions: FunctionalSurfaceDefinition[] = [];
  #temporaryIndex = 0;

  constructor(private readonly prepared: PreparedEffectCore) {}

  lower(
    expression: FunctionalEffectCoreExpression,
    continuation: FunctionalSurfaceExpression,
    handlers: ReadonlyMap<string, ScopedEffectHandler>,
  ): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "return":
        return surface.apply(continuation, expression.value);
      case "host-call": {
        const operation = this.hostOperation(expression.capability, expression.operation);
        if (operation.host === undefined) {
          throw new Error(
            `Functional Effect Core host operation ${
              JSON.stringify(operation.key)
            } omitted its binder`,
          );
        }
        const call = surface.apply(surface.name(operation.host.binder), expression.argument);
        if (operation.effectBit === null) return surface.apply(continuation, call);
        return this.strictContinue(call, operation.result, continuation);
      }
      case "perform": {
        const key = operationKey(expression.effect, expression.operation);
        const handler = handlers.get(key);
        if (handler === undefined) {
          throw new Error(`Verified Functional Effect Core omitted handler ${JSON.stringify(key)}`);
        }
        return this.strictContinue(
          surface.apply(surface.name(handler.definition), expression.argument),
          handler.operation.result,
          continuation,
        );
      }
      case "bind":
        return this.lower(expression.computation, {
          kind: "lambda",
          parameter: expression.name,
          body: this.lower(expression.body, continuation, handlers),
        }, handlers);
      case "branch":
        return {
          kind: "if",
          condition: expression.condition,
          consequent: this.lower(expression.consequent, continuation, handlers),
          alternate: this.lower(expression.alternate, continuation, handlers),
        };
      case "handle": {
        const operation = this.localOperation(expression.effect, expression.operation);
        const name = `$FunctionalEffectHandler${this.handlerDefinitions.length}`;
        this.handlerDefinitions.push({
          name,
          parameters: [],
          annotation: {
            kind: "function",
            parameter: operation.parameter,
            result: operation.result,
          },
          body: expression.implementation,
        });
        const scoped = new Map(handlers);
        scoped.set(operation.key, { definition: name, operation });
        return this.lower(expression.computation, continuation, scoped);
      }
    }
  }

  private strictContinue(
    call: FunctionalSurfaceExpression,
    type: FunctionalHostScalarType,
    continuation: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const name = `$FunctionalEffectValue${this.#temporaryIndex}`;
    this.#temporaryIndex += 1;
    const value = surface.name(name);
    let body: FunctionalSurfaceExpression;
    if (type.kind === "integer") {
      const resumed = surface.apply(continuation, value);
      body = {
        kind: "if",
        condition: surface.binary(FunctionalBinaryOperator.Equal, value, value),
        consequent: resumed,
        alternate: resumed,
      };
    } else if (type.kind === "boolean") {
      body = {
        kind: "if",
        condition: value,
        consequent: surface.apply(continuation, surface.boolean(true)),
        alternate: surface.apply(continuation, surface.boolean(false)),
      };
    } else {
      body = {
        kind: "case",
        value,
        arms: [{
          constructor: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
          binders: [],
          body: surface.apply(continuation, surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME)),
        }],
      };
    }
    return { kind: "let", name, value: call, body };
  }

  private localOperation(effect: string, name: string): PreparedOperation {
    const key = operationKey(effect, name);
    const operation = this.prepared.operations.find((candidate) =>
      candidate.kind === "local" && candidate.key === key
    );
    if (operation === undefined) {
      throw new Error(
        `Verified Functional Effect Core omitted local operation ${JSON.stringify(key)}`,
      );
    }
    return operation;
  }

  private hostOperation(capability: string, name: string): PreparedOperation {
    const key = operationKey(capability, name);
    const operation = this.prepared.operations.find((candidate) =>
      candidate.kind === "host" && candidate.key === key
    );
    if (operation === undefined) {
      throw new Error(
        `Verified Functional Effect Core omitted host operation ${JSON.stringify(key)}`,
      );
    }
    return operation;
  }
}

interface ScopedEffectHandler {
  readonly definition: string;
  readonly operation: PreparedOperation;
}
