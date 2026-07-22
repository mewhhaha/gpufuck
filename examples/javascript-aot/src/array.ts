import { FunctionalBinaryOperator } from "../../../src/functional/abi.ts";
import type {
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "../../../src/functional/surface_builder.ts";

export const JAVASCRIPT_ARRAY_TYPE = "$javascript#Array";
export const JAVASCRIPT_ARRAY_EMPTY = "$javascript#ArrayEmpty";
export const JAVASCRIPT_ARRAY_ELEMENT = "$javascript#ArrayElement";
export const JAVASCRIPT_ARRAY_LENGTH = "$javascript#arrayLength";
export const JAVASCRIPT_ARRAY_INDEX = "$javascript#arrayIndex";
export const JAVASCRIPT_ARRAY_MAP = "$javascript#arrayMap";
export const JAVASCRIPT_ARRAY_REDUCE = "$javascript#arrayReduce";

export interface JavaScriptArraySurface {
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
}

export function javascriptArraySurface(
  sourceByteLength: number,
  requiredDefinitions: ReadonlySet<string>,
): JavaScriptArraySurface {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  const surface: JavaScriptArraySurface = {
    definitions: [{
      name: JAVASCRIPT_ARRAY_LENGTH,
      parameters: ["array"],
      annotation: null,
      body: {
        kind: "case",
        value: { kind: "name", name: "array", span },
        arms: [{
          constructor: JAVASCRIPT_ARRAY_EMPTY,
          binders: [],
          body: { kind: "float-64", value: 0, span },
          span,
        }, {
          constructor: JAVASCRIPT_ARRAY_ELEMENT,
          binders: ["head", "tail"],
          body: {
            kind: "binary",
            operator: FunctionalBinaryOperator.AddFloat64,
            left: { kind: "float-64", value: 1, span },
            right: apply(
              { kind: "name", name: JAVASCRIPT_ARRAY_LENGTH, span },
              [{ kind: "name", name: "tail", span }],
              span,
            ),
            span,
          },
          span,
        }],
        span,
      },
      span,
    }, {
      name: JAVASCRIPT_ARRAY_INDEX,
      parameters: ["array", "index"],
      annotation: null,
      body: {
        kind: "if",
        condition: {
          kind: "binary",
          operator: FunctionalBinaryOperator.LessFloat64,
          left: { kind: "name", name: "index", span },
          right: { kind: "float-64", value: 0, span },
          span,
        },
        consequent: {
          kind: "runtime-fault",
          message: "JavaScript array index is negative or fractional",
          span,
        },
        alternate: {
          kind: "case",
          value: { kind: "name", name: "array", span },
          arms: [{
            constructor: JAVASCRIPT_ARRAY_EMPTY,
            binders: [],
            body: {
              kind: "runtime-fault",
              message: "JavaScript array index is outside the immutable array",
              span,
            },
            span,
          }, {
            constructor: JAVASCRIPT_ARRAY_ELEMENT,
            binders: ["head", "tail"],
            body: {
              kind: "if",
              condition: {
                kind: "binary",
                operator: FunctionalBinaryOperator.EqualFloat64,
                left: { kind: "name", name: "index", span },
                right: { kind: "float-64", value: 0, span },
                span,
              },
              consequent: { kind: "name", name: "head", span },
              alternate: apply(
                { kind: "name", name: JAVASCRIPT_ARRAY_INDEX, span },
                [
                  { kind: "name", name: "tail", span },
                  {
                    kind: "binary",
                    operator: FunctionalBinaryOperator.SubtractFloat64,
                    left: { kind: "name", name: "index", span },
                    right: { kind: "float-64", value: 1, span },
                    span,
                  },
                ],
                span,
              ),
              span,
            },
            span,
          }],
          span,
        },
        span,
      },
      span,
    }, {
      name: JAVASCRIPT_ARRAY_MAP,
      parameters: ["transform", "array"],
      annotation: null,
      body: {
        kind: "case",
        value: { kind: "name", name: "array", span },
        arms: [{
          constructor: JAVASCRIPT_ARRAY_EMPTY,
          binders: [],
          body: { kind: "name", name: JAVASCRIPT_ARRAY_EMPTY, span },
          span,
        }, {
          constructor: JAVASCRIPT_ARRAY_ELEMENT,
          binders: ["head", "tail"],
          body: apply(
            { kind: "name", name: JAVASCRIPT_ARRAY_ELEMENT, span },
            [
              apply(
                { kind: "name", name: "transform", span },
                [{ kind: "name", name: "head", span }],
                span,
              ),
              apply(
                { kind: "name", name: JAVASCRIPT_ARRAY_MAP, span },
                [
                  { kind: "name", name: "transform", span },
                  { kind: "name", name: "tail", span },
                ],
                span,
              ),
            ],
            span,
          ),
          span,
        }],
        span,
      },
      span,
    }, {
      name: JAVASCRIPT_ARRAY_REDUCE,
      parameters: ["reducer", "accumulator", "array"],
      annotation: null,
      body: {
        kind: "case",
        value: { kind: "name", name: "array", span },
        arms: [{
          constructor: JAVASCRIPT_ARRAY_EMPTY,
          binders: [],
          body: { kind: "name", name: "accumulator", span },
          span,
        }, {
          constructor: JAVASCRIPT_ARRAY_ELEMENT,
          binders: ["head", "tail"],
          body: apply(
            { kind: "name", name: JAVASCRIPT_ARRAY_REDUCE, span },
            [
              { kind: "name", name: "reducer", span },
              apply(
                { kind: "name", name: "reducer", span },
                [
                  { kind: "name", name: "accumulator", span },
                  { kind: "name", name: "head", span },
                ],
                span,
              ),
              { kind: "name", name: "tail", span },
            ],
            span,
          ),
          span,
        }],
        span,
      },
      span,
    }],
    typeDeclarations: [{
      name: JAVASCRIPT_ARRAY_TYPE,
      parameters: ["element"],
      span,
      constructors: [{
        name: JAVASCRIPT_ARRAY_EMPTY,
        fields: [],
        span,
      }, {
        name: JAVASCRIPT_ARRAY_ELEMENT,
        fields: [{
          name: "head",
          type: { kind: "parameter", name: "element" },
          span,
        }, {
          name: "tail",
          type: {
            kind: "named",
            name: JAVASCRIPT_ARRAY_TYPE,
            arguments: [{ kind: "parameter", name: "element" }],
          },
          span,
        }],
        span,
      }],
    }],
  };
  return {
    definitions: surface.definitions.filter((definition) =>
      requiredDefinitions.has(definition.name)
    ),
    typeDeclarations: surface.typeDeclarations,
  };
}

function apply(
  callee: FunctionalSurfaceExpression,
  arguments_: readonly FunctionalSurfaceExpression[],
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  let expression = callee;
  for (const argument of arguments_) {
    expression = { kind: "apply", callee: expression, argument, span };
  }
  return expression;
}
