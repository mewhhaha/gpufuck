import type { FunctionalTypeSchema } from "./abi.ts";
import type {
  FunctionalEffectCoreExpression,
  FunctionalEffectCoreModule,
} from "./effect_core_contract.ts";
import { prepareFunctionalEffectCore } from "./effect_core_encoding.ts";
import type {
  FunctionalEffectExpression,
  FunctionalEffectHandler,
  FunctionalEffectOperation,
  FunctionalEffectProgram,
  FunctionalEffectType,
  LoweredFunctionalEffectProgram,
} from "./effect_contract.ts";
import type { FunctionalSurfaceExpression } from "./surface_builder.ts";

const COMPATIBILITY_ENTRY_NAME = "$FunctionalEffectMain";

interface AnalyzedEffectExpression {
  readonly valueType: FunctionalTypeSchema;
  readonly operations: ReadonlySet<string>;
}

function effectCoreProgramShape(
  program: FunctionalEffectProgram,
): FunctionalEffectCoreModule {
  const operations = indexOperations(program.operations);
  const handlers = indexHandlers(program.handlers, operations);
  const analyzed = analyzeEffectExpression(program.expression, operations);
  for (const operation of analyzed.operations) {
    if (handlers.has(operation)) continue;
    throw new Error(
      `Functional effect program performs ${JSON.stringify(operation)} without a handler`,
    );
  }

  let expression = effectCoreExpression(program.expression, operations);
  for (const handler of [...program.handlers].reverse()) {
    expression = {
      kind: "handle",
      effect: handler.effect,
      operation: handler.operation,
      implementation: handler.implementation,
      computation: expression,
    };
  }

  return Object.freeze({
    definitions: Object.freeze([]),
    typeDeclarations: Object.freeze([]),
    operations: Object.freeze([...program.operations]),
    hostCapabilities: Object.freeze([]),
    expression,
    entryName: COMPATIBILITY_ENTRY_NAME,
    sourceByteLength: 0,
  });
}

export function lowerFunctionalEffectProgram(
  program: FunctionalEffectProgram,
): LoweredFunctionalEffectProgram {
  const operations = indexOperations(program.operations);
  const handlers = indexHandlers(program.handlers, operations);
  const analyzed = analyzeEffectExpression(program.expression, operations);
  for (const operation of analyzed.operations) {
    if (handlers.has(operation)) continue;
    throw new Error(
      `Functional effect program performs ${JSON.stringify(operation)} without a handler`,
    );
  }
  prepareFunctionalEffectCore(effectCoreProgramShape(program));

  const handlerNames = new Map<string, string>();
  const definitions = program.handlers.map((handler, handlerIndex) => {
    const key = operationKey(handler.effect, handler.operation);
    const operation = operations.get(key);
    if (operation === undefined) {
      throw new Error(`Functional effect lowering omitted operation ${JSON.stringify(key)}`);
    }
    const name = `$FunctionalEffectHandler${handlerIndex}`;
    handlerNames.set(key, name);
    return Object.freeze({
      name,
      parameters: Object.freeze([]),
      annotation: Object.freeze({
        kind: "function" as const,
        parameter: operation.parameter,
        result: Object.freeze({
          kind: "function" as const,
          parameter: Object.freeze({
            kind: "function" as const,
            parameter: operation.result,
            result: analyzed.valueType,
          }),
          result: analyzed.valueType,
        }),
      }),
      body: handler.implementation,
    });
  });
  const lowering = new EffectCpsLowering(handlerNames);
  const resultName = "$FunctionalEffectResult";
  const expression = lowering.lower(program.expression, {
    kind: "lambda",
    parameter: resultName,
    body: { kind: "name", name: resultName },
  });
  const computationType: FunctionalEffectType = Object.freeze({
    value: analyzed.valueType,
    effects: Object.freeze([...analyzed.operations]),
  });
  const resultType: FunctionalEffectType = Object.freeze({
    value: analyzed.valueType,
    effects: Object.freeze([]),
  });
  return Object.freeze({
    definitions: Object.freeze(definitions),
    expression,
    computationType,
    resultType,
  });
}

class EffectCpsLowering {
  constructor(
    private readonly handlerNames: ReadonlyMap<string, string>,
  ) {}

  lower(
    expression: FunctionalEffectExpression,
    continuation: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "pure":
        return {
          kind: "apply",
          callee: continuation,
          argument: expression.value,
          ...(expression.span === undefined ? {} : { span: expression.span }),
        };
      case "perform": {
        const operation = operationKey(expression.effect, expression.operation);
        const handlerName = this.handlerNames.get(operation);
        if (handlerName === undefined) {
          throw new Error(
            `Functional effect lowering omitted handler ${JSON.stringify(operation)}`,
          );
        }
        return {
          kind: "apply",
          callee: {
            kind: "apply",
            callee: {
              kind: "name",
              name: handlerName,
              ...(expression.span === undefined ? {} : { span: expression.span }),
            },
            argument: expression.argument,
            ...(expression.span === undefined ? {} : { span: expression.span }),
          },
          argument: continuation,
          ...(expression.span === undefined ? {} : { span: expression.span }),
        };
      }
      case "bind":
        return this.lower(expression.computation, {
          kind: "lambda",
          parameter: expression.name,
          body: this.lower(expression.body, continuation),
          ...(expression.span === undefined ? {} : { span: expression.span }),
        });
    }
  }
}

function effectCoreExpression(
  expression: FunctionalEffectExpression,
  operations: ReadonlyMap<string, FunctionalEffectOperation>,
): FunctionalEffectCoreExpression {
  switch (expression.kind) {
    case "pure":
      return {
        kind: "return",
        value: expression.value,
        valueType: expression.valueType,
      };
    case "perform": {
      const key = operationKey(expression.effect, expression.operation);
      const operation = operations.get(key);
      if (operation === undefined) {
        throw new Error(
          `Functional effect expression performs unknown operation ${JSON.stringify(key)}`,
        );
      }
      return {
        kind: "perform",
        effect: expression.effect,
        operation: expression.operation,
        argument: expression.argument,
        argumentType: operation.parameter,
      };
    }
    case "bind":
      return {
        kind: "bind",
        name: expression.name,
        computation: effectCoreExpression(expression.computation, operations),
        body: effectCoreExpression(expression.body, operations),
      };
  }
}

function indexOperations(
  declarations: readonly FunctionalEffectOperation[],
): ReadonlyMap<string, FunctionalEffectOperation> {
  const operations = new Map<string, FunctionalEffectOperation>();
  for (const [declarationIndex, declaration] of declarations.entries()) {
    requireName(declaration.effect, `operation ${declarationIndex} effect`);
    requireName(declaration.name, `operation ${declarationIndex} name`);
    const key = operationKey(declaration.effect, declaration.name);
    if (operations.has(key)) {
      throw new Error(`Functional effect program repeats operation ${JSON.stringify(key)}`);
    }
    operations.set(key, declaration);
  }
  return operations;
}

function indexHandlers(
  declarations: readonly FunctionalEffectHandler[],
  operations: ReadonlyMap<string, FunctionalEffectOperation>,
): ReadonlyMap<string, FunctionalEffectHandler> {
  const handlers = new Map<string, FunctionalEffectHandler>();
  for (const [declarationIndex, declaration] of declarations.entries()) {
    requireName(declaration.effect, `handler ${declarationIndex} effect`);
    requireName(declaration.operation, `handler ${declarationIndex} operation`);
    const key = operationKey(declaration.effect, declaration.operation);
    if (!operations.has(key)) {
      throw new Error(
        `Functional effect handler references unknown operation ${JSON.stringify(key)}`,
      );
    }
    if (handlers.has(key)) {
      throw new Error(`Functional effect program repeats handler ${JSON.stringify(key)}`);
    }
    handlers.set(key, declaration);
  }
  return handlers;
}

function analyzeEffectExpression(
  expression: FunctionalEffectExpression,
  operations: ReadonlyMap<string, FunctionalEffectOperation>,
): AnalyzedEffectExpression {
  switch (expression.kind) {
    case "pure":
      return { valueType: expression.valueType, operations: new Set() };
    case "perform": {
      const key = operationKey(expression.effect, expression.operation);
      const operation = operations.get(key);
      if (operation === undefined) {
        throw new Error(
          `Functional effect expression performs unknown operation ${JSON.stringify(key)}`,
        );
      }
      return { valueType: operation.result, operations: new Set([key]) };
    }
    case "bind": {
      requireName(expression.name, "bind name");
      const computation = analyzeEffectExpression(expression.computation, operations);
      const body = analyzeEffectExpression(expression.body, operations);
      return {
        valueType: body.valueType,
        operations: new Set([...computation.operations, ...body.operations]),
      };
    }
  }
}

function operationKey(effect: string, operation: string): string {
  return `${effect}.${operation}`;
}

function requireName(name: string, location: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `Functional effect ${location} must have a nonempty name; received ${JSON.stringify(name)}`,
    );
  }
}
