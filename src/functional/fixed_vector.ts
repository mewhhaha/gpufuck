import {
  FunctionalBinaryOperator,
  type FunctionalBinaryOperator as FunctionalBinaryOperatorValue,
} from "./abi.ts";
import type {
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "./surface_contract.ts";
import type { FunctionalTypeSchema } from "./schema_contract.ts";
import { surface } from "./surface_builder.ts";
import {
  FUNCTIONAL_F32X4_CONSTRUCTOR_NAME,
  FUNCTIONAL_F32X4_TYPE_NAME,
  FUNCTIONAL_MASK32X4_CONSTRUCTOR_NAME,
  FUNCTIONAL_MASK32X4_TYPE_NAME,
  FunctionalF32x4Definition,
} from "./fixed_vector_contract.ts";

export {
  FUNCTIONAL_F32X4_CONSTRUCTOR_NAME,
  FUNCTIONAL_F32X4_TYPE_NAME,
  FUNCTIONAL_MASK32X4_CONSTRUCTOR_NAME,
  FUNCTIONAL_MASK32X4_TYPE_NAME,
  FunctionalF32x4Definition,
} from "./fixed_vector_contract.ts";

const FLOAT32_TYPE: FunctionalTypeSchema = Object.freeze({ kind: "float-32" });
const BOOLEAN_TYPE: FunctionalTypeSchema = Object.freeze({ kind: "boolean" });
const F32X4_TYPE: FunctionalTypeSchema = Object.freeze({
  kind: "named",
  name: FUNCTIONAL_F32X4_TYPE_NAME,
  arguments: Object.freeze([]),
});
const MASK32X4_TYPE: FunctionalTypeSchema = Object.freeze({
  kind: "named",
  name: FUNCTIONAL_MASK32X4_TYPE_NAME,
  arguments: Object.freeze([]),
});

export const FUNCTIONAL_FIXED_VECTOR_TYPE_DECLARATIONS:
  readonly FunctionalSurfaceTypeDeclaration[] = Object.freeze([
    Object.freeze({
      name: FUNCTIONAL_F32X4_TYPE_NAME,
      parameters: Object.freeze([]),
      constructors: Object.freeze([Object.freeze({
        name: FUNCTIONAL_F32X4_CONSTRUCTOR_NAME,
        fields: Object.freeze(
          Array.from(
            { length: 4 },
            (_, lane) => Object.freeze({ name: `lane${lane}`, type: FLOAT32_TYPE }),
          ),
        ),
      })]),
    }),
    Object.freeze({
      name: FUNCTIONAL_MASK32X4_TYPE_NAME,
      parameters: Object.freeze([]),
      constructors: Object.freeze([Object.freeze({
        name: FUNCTIONAL_MASK32X4_CONSTRUCTOR_NAME,
        fields: Object.freeze(
          Array.from(
            { length: 4 },
            (_, lane) => Object.freeze({ name: `lane${lane}`, type: BOOLEAN_TYPE }),
          ),
        ),
      })]),
    }),
  ]);

export const FUNCTIONAL_FIXED_VECTOR_DEFINITIONS: readonly FunctionalSurfaceDefinition[] = Object
  .freeze([
    vectorDefinition(
      FunctionalF32x4Definition.Splat,
      ["value"],
      functionType([FLOAT32_TYPE], F32X4_TYPE),
      f32x4Constructor(Array.from({ length: 4 }, () => surface.name("value"))),
    ),
    vectorBinaryDefinition(
      FunctionalF32x4Definition.Add,
      FunctionalBinaryOperator.AddFloat32,
    ),
    vectorBinaryDefinition(
      FunctionalF32x4Definition.Subtract,
      FunctionalBinaryOperator.SubtractFloat32,
    ),
    vectorBinaryDefinition(
      FunctionalF32x4Definition.Multiply,
      FunctionalBinaryOperator.MultiplyFloat32,
    ),
    vectorBinaryDefinition(
      FunctionalF32x4Definition.Divide,
      FunctionalBinaryOperator.DivideFloat32,
    ),
    vectorComparisonDefinition(
      FunctionalF32x4Definition.Equal,
      FunctionalBinaryOperator.EqualFloat32,
    ),
    vectorComparisonDefinition(
      FunctionalF32x4Definition.Less,
      FunctionalBinaryOperator.LessFloat32,
    ),
    vectorSelectDefinition(),
    ...Array.from({ length: 4 }, (_, lane) => vectorExtractDefinition(lane)),
    ...Array.from({ length: 4 }, (_, lane) => vectorReplaceDefinition(lane)),
    vectorReduceAddDefinition(),
    vectorMapDefinition(),
    vectorZipDefinition(),
    vectorFoldDefinition(),
  ]);

export const functionalF32x4: Readonly<{
  readonly type: FunctionalTypeSchema;
  readonly maskType: FunctionalTypeSchema;
  make(
    lanes: readonly [
      FunctionalSurfaceExpression,
      FunctionalSurfaceExpression,
      FunctionalSurfaceExpression,
      FunctionalSurfaceExpression,
    ],
  ): FunctionalSurfaceExpression;
  splat(value: FunctionalSurfaceExpression): FunctionalSurfaceExpression;
  add(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  subtract(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  multiply(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  divide(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  equal(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  less(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  select(
    mask: FunctionalSurfaceExpression,
    whenTrue: FunctionalSurfaceExpression,
    whenFalse: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  extractLane(vector: FunctionalSurfaceExpression, lane: number): FunctionalSurfaceExpression;
  replaceLane(
    vector: FunctionalSurfaceExpression,
    lane: number,
    value: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  reduceAdd(vector: FunctionalSurfaceExpression): FunctionalSurfaceExpression;
  map(
    transform: FunctionalSurfaceExpression,
    vector: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  zip(
    combine: FunctionalSurfaceExpression,
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  fold(
    combine: FunctionalSurfaceExpression,
    initial: FunctionalSurfaceExpression,
    vector: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
}> = Object.freeze({
  type: F32X4_TYPE,
  maskType: MASK32X4_TYPE,
  make: f32x4Constructor,
  splat: (value) => vectorCall(FunctionalF32x4Definition.Splat, [value]),
  add: (left, right) => vectorCall(FunctionalF32x4Definition.Add, [left, right]),
  subtract: (left, right) => vectorCall(FunctionalF32x4Definition.Subtract, [left, right]),
  multiply: (left, right) => vectorCall(FunctionalF32x4Definition.Multiply, [left, right]),
  divide: (left, right) => vectorCall(FunctionalF32x4Definition.Divide, [left, right]),
  equal: (left, right) => vectorCall(FunctionalF32x4Definition.Equal, [left, right]),
  less: (left, right) => vectorCall(FunctionalF32x4Definition.Less, [left, right]),
  select: (mask, whenTrue, whenFalse) =>
    vectorCall(FunctionalF32x4Definition.Select, [mask, whenTrue, whenFalse]),
  extractLane(vector, lane) {
    return vectorCall(extractDefinition(lane), [vector]);
  },
  replaceLane(vector, lane, value) {
    return vectorCall(replaceDefinition(lane), [vector, value]);
  },
  reduceAdd: (vector) => vectorCall(FunctionalF32x4Definition.ReduceAdd, [vector]),
  map: (transform, vector) => vectorCall(FunctionalF32x4Definition.Map, [transform, vector]),
  zip: (combine, left, right) => vectorCall(FunctionalF32x4Definition.Zip, [combine, left, right]),
  fold: (combine, initial, vector) =>
    vectorCall(FunctionalF32x4Definition.Fold, [combine, initial, vector]),
});

function vectorBinaryDefinition(
  name: string,
  operator: FunctionalBinaryOperatorValue,
): FunctionalSurfaceDefinition {
  return vectorDefinition(
    name,
    ["left", "right"],
    functionType([F32X4_TYPE, F32X4_TYPE], F32X4_TYPE),
    f32x4Case(
      "left",
      "leftLane",
      (leftLanes) =>
        f32x4Case(
          "right",
          "rightLane",
          (rightLanes) =>
            f32x4Constructor(
              leftLanes.map((left, lane) => surface.binary(operator, left, rightLanes[lane]!)),
            ),
        ),
    ),
  );
}

function vectorComparisonDefinition(
  name: string,
  operator: FunctionalBinaryOperatorValue,
): FunctionalSurfaceDefinition {
  return vectorDefinition(
    name,
    ["left", "right"],
    functionType([F32X4_TYPE, F32X4_TYPE], MASK32X4_TYPE),
    f32x4Case(
      "left",
      "leftLane",
      (leftLanes) =>
        f32x4Case(
          "right",
          "rightLane",
          (rightLanes) =>
            mask32x4Constructor(
              leftLanes.map((left, lane) => surface.binary(operator, left, rightLanes[lane]!)),
            ),
        ),
    ),
  );
}

function vectorSelectDefinition(): FunctionalSurfaceDefinition {
  return vectorDefinition(
    FunctionalF32x4Definition.Select,
    ["mask", "whenTrue", "whenFalse"],
    functionType([MASK32X4_TYPE, F32X4_TYPE, F32X4_TYPE], F32X4_TYPE),
    mask32x4Case("mask", "maskLane", (maskLanes) => {
      return f32x4Case("whenTrue", "trueLane", (trueLanes) => {
        return f32x4Case(
          "whenFalse",
          "falseLane",
          (falseLanes) =>
            f32x4Constructor(maskLanes.map((mask, lane) => ({
              kind: "if",
              condition: mask,
              consequent: trueLanes[lane]!,
              alternate: falseLanes[lane]!,
            }))),
        );
      });
    }),
  );
}

function vectorExtractDefinition(lane: number): FunctionalSurfaceDefinition {
  return vectorDefinition(
    extractDefinition(lane),
    ["vector"],
    functionType([F32X4_TYPE], FLOAT32_TYPE),
    f32x4Case("vector", "lane", (lanes) => lanes[lane]!),
  );
}

function vectorReplaceDefinition(lane: number): FunctionalSurfaceDefinition {
  return vectorDefinition(
    replaceDefinition(lane),
    ["vector", "replacement"],
    functionType([F32X4_TYPE, FLOAT32_TYPE], F32X4_TYPE),
    f32x4Case(
      "vector",
      "lane",
      (lanes) =>
        f32x4Constructor(
          lanes.map((value, index) => index === lane ? surface.name("replacement") : value),
        ),
    ),
  );
}

function vectorReduceAddDefinition(): FunctionalSurfaceDefinition {
  return vectorDefinition(
    FunctionalF32x4Definition.ReduceAdd,
    ["vector"],
    functionType([F32X4_TYPE], FLOAT32_TYPE),
    f32x4Case("vector", "lane", ([lane0, lane1, lane2, lane3]) =>
      surface.binary(
        FunctionalBinaryOperator.AddFloat32,
        surface.binary(FunctionalBinaryOperator.AddFloat32, lane0!, lane1!),
        surface.binary(FunctionalBinaryOperator.AddFloat32, lane2!, lane3!),
      )),
  );
}

function vectorMapDefinition(): FunctionalSurfaceDefinition {
  const transformType = functionType([FLOAT32_TYPE], FLOAT32_TYPE);
  return vectorDefinition(
    FunctionalF32x4Definition.Map,
    ["transform", "vector"],
    functionType([transformType, F32X4_TYPE], F32X4_TYPE),
    f32x4Case(
      "vector",
      "lane",
      (lanes) =>
        f32x4Constructor(lanes.map((lane) => surface.apply(surface.name("transform"), lane))),
    ),
  );
}

function vectorZipDefinition(): FunctionalSurfaceDefinition {
  const combineType = functionType([FLOAT32_TYPE, FLOAT32_TYPE], FLOAT32_TYPE);
  return vectorDefinition(
    FunctionalF32x4Definition.Zip,
    ["combine", "left", "right"],
    functionType([combineType, F32X4_TYPE, F32X4_TYPE], F32X4_TYPE),
    f32x4Case(
      "left",
      "leftLane",
      (leftLanes) =>
        f32x4Case(
          "right",
          "rightLane",
          (rightLanes) =>
            f32x4Constructor(
              leftLanes.map((left, lane) =>
                surface.apply(surface.name("combine"), left, rightLanes[lane]!)
              ),
            ),
        ),
    ),
  );
}

function vectorFoldDefinition(): FunctionalSurfaceDefinition {
  const combineType = functionType([FLOAT32_TYPE, FLOAT32_TYPE], FLOAT32_TYPE);
  return vectorDefinition(
    FunctionalF32x4Definition.Fold,
    ["combine", "initial", "vector"],
    functionType([combineType, FLOAT32_TYPE, F32X4_TYPE], FLOAT32_TYPE),
    f32x4Case("vector", "lane", (lanes) =>
      lanes.reduce<FunctionalSurfaceExpression>(
        (accumulator, lane) => surface.apply(surface.name("combine"), accumulator, lane),
        surface.name("initial"),
      )),
  );
}

function f32x4Case(
  value: string,
  binderPrefix: string,
  body: (lanes: readonly FunctionalSurfaceExpression[]) => FunctionalSurfaceExpression,
): FunctionalSurfaceExpression {
  return vectorCase(FUNCTIONAL_F32X4_CONSTRUCTOR_NAME, value, binderPrefix, body);
}

function mask32x4Case(
  value: string,
  binderPrefix: string,
  body: (lanes: readonly FunctionalSurfaceExpression[]) => FunctionalSurfaceExpression,
): FunctionalSurfaceExpression {
  return vectorCase(FUNCTIONAL_MASK32X4_CONSTRUCTOR_NAME, value, binderPrefix, body);
}

function vectorCase(
  constructor: string,
  value: string,
  binderPrefix: string,
  body: (lanes: readonly FunctionalSurfaceExpression[]) => FunctionalSurfaceExpression,
): FunctionalSurfaceExpression {
  const binders = Array.from({ length: 4 }, (_, lane) => `${binderPrefix}${lane}`);
  return {
    kind: "case",
    value: surface.name(value),
    arms: [{
      constructor,
      binders,
      body: body(binders.map(surface.name)),
    }],
  };
}

function f32x4Constructor(
  lanes: readonly FunctionalSurfaceExpression[],
): FunctionalSurfaceExpression {
  return vectorConstructor(FUNCTIONAL_F32X4_CONSTRUCTOR_NAME, lanes);
}

function mask32x4Constructor(
  lanes: readonly FunctionalSurfaceExpression[],
): FunctionalSurfaceExpression {
  return vectorConstructor(FUNCTIONAL_MASK32X4_CONSTRUCTOR_NAME, lanes);
}

function vectorConstructor(
  constructor: string,
  lanes: readonly FunctionalSurfaceExpression[],
): FunctionalSurfaceExpression {
  if (lanes.length !== 4) {
    throw new RangeError(`functional fixed vector requires 4 lanes; received ${lanes.length}`);
  }
  return surface.apply(surface.name(constructor), ...lanes);
}

function vectorCall(
  definition: string,
  arguments_: readonly FunctionalSurfaceExpression[],
): FunctionalSurfaceExpression {
  return surface.apply(surface.name(definition), ...arguments_);
}

function vectorDefinition(
  name: string,
  parameters: readonly string[],
  annotation: FunctionalTypeSchema,
  body: FunctionalSurfaceExpression,
): FunctionalSurfaceDefinition {
  // Native lowering trusts these reserved definitions, so their scalar bodies must not be mutable.
  const pendingObjects: object[] = [body];
  const frozenObjects = new Set<object>();
  while (pendingObjects.length > 0) {
    const current = pendingObjects.pop()!;
    if (frozenObjects.has(current)) continue;
    frozenObjects.add(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pendingObjects.push(child);
    }
    Object.freeze(current);
  }
  return Object.freeze({ name, parameters: Object.freeze([...parameters]), annotation, body });
}

function functionType(
  parameters: readonly FunctionalTypeSchema[],
  result: FunctionalTypeSchema,
): FunctionalTypeSchema {
  return parameters.reduceRight<FunctionalTypeSchema>(
    (body, parameter) => Object.freeze({ kind: "function", parameter, result: body }),
    result,
  );
}

function extractDefinition(lane: number): string {
  requireLane(lane);
  return [
    FunctionalF32x4Definition.ExtractLane0,
    FunctionalF32x4Definition.ExtractLane1,
    FunctionalF32x4Definition.ExtractLane2,
    FunctionalF32x4Definition.ExtractLane3,
  ][lane]!;
}

function replaceDefinition(lane: number): string {
  requireLane(lane);
  return [
    FunctionalF32x4Definition.ReplaceLane0,
    FunctionalF32x4Definition.ReplaceLane1,
    FunctionalF32x4Definition.ReplaceLane2,
    FunctionalF32x4Definition.ReplaceLane3,
  ][lane]!;
}

function requireLane(lane: number): void {
  if (Number.isInteger(lane) && lane >= 0 && lane < 4) return;
  throw new RangeError(`functional F32x4 lane must be an integer within [0, 3]; received ${lane}`);
}
