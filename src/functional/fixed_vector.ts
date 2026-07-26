import { BinaryOperator, type BinaryOperator as BinaryOperatorValue } from "./abi.ts";
import type {
  SurfaceDefinition,
  SurfaceExpression,
  SurfaceTypeDeclaration,
} from "./surface_contract.ts";
import type { TypeSchema } from "./schema_contract.ts";
import { surface } from "./surface_builder.ts";
import {
  F32X4_CONSTRUCTOR_NAME,
  F32X4_TYPE_NAME,
  F32x4Definition,
  MASK32X4_CONSTRUCTOR_NAME,
  MASK32X4_TYPE_NAME,
} from "./fixed_vector_contract.ts";

export {
  F32X4_CONSTRUCTOR_NAME,
  F32X4_TYPE_NAME,
  F32x4Definition,
  MASK32X4_CONSTRUCTOR_NAME,
  MASK32X4_TYPE_NAME,
} from "./fixed_vector_contract.ts";

const FLOAT32_TYPE: TypeSchema = Object.freeze({ kind: "float-32" });
const BOOLEAN_TYPE: TypeSchema = Object.freeze({ kind: "boolean" });
const F32X4_TYPE: TypeSchema = Object.freeze({
  kind: "named",
  name: F32X4_TYPE_NAME,
  arguments: Object.freeze([]),
});
const MASK32X4_TYPE: TypeSchema = Object.freeze({
  kind: "named",
  name: MASK32X4_TYPE_NAME,
  arguments: Object.freeze([]),
});

export const FIXED_VECTOR_TYPE_DECLARATIONS: readonly SurfaceTypeDeclaration[] = Object.freeze([
  Object.freeze({
    name: F32X4_TYPE_NAME,
    parameters: Object.freeze([]),
    constructors: Object.freeze([Object.freeze({
      name: F32X4_CONSTRUCTOR_NAME,
      fields: Object.freeze(
        Array.from(
          { length: 4 },
          (_, lane) => Object.freeze({ name: `lane${lane}`, type: FLOAT32_TYPE }),
        ),
      ),
    })]),
  }),
  Object.freeze({
    name: MASK32X4_TYPE_NAME,
    parameters: Object.freeze([]),
    constructors: Object.freeze([Object.freeze({
      name: MASK32X4_CONSTRUCTOR_NAME,
      fields: Object.freeze(
        Array.from(
          { length: 4 },
          (_, lane) => Object.freeze({ name: `lane${lane}`, type: BOOLEAN_TYPE }),
        ),
      ),
    })]),
  }),
]);

export const FIXED_VECTOR_DEFINITIONS: readonly SurfaceDefinition[] = Object
  .freeze([
    vectorDefinition(
      F32x4Definition.Splat,
      ["value"],
      functionType([FLOAT32_TYPE], F32X4_TYPE),
      f32x4Constructor(Array.from({ length: 4 }, () => surface.name("value"))),
    ),
    vectorBinaryDefinition(
      F32x4Definition.Add,
      BinaryOperator.AddFloat32,
    ),
    vectorBinaryDefinition(
      F32x4Definition.Subtract,
      BinaryOperator.SubtractFloat32,
    ),
    vectorBinaryDefinition(
      F32x4Definition.Multiply,
      BinaryOperator.MultiplyFloat32,
    ),
    vectorBinaryDefinition(
      F32x4Definition.Divide,
      BinaryOperator.DivideFloat32,
    ),
    vectorComparisonDefinition(
      F32x4Definition.Equal,
      BinaryOperator.EqualFloat32,
    ),
    vectorComparisonDefinition(
      F32x4Definition.Less,
      BinaryOperator.LessFloat32,
    ),
    vectorSelectDefinition(),
    ...Array.from({ length: 4 }, (_, lane) => vectorExtractDefinition(lane)),
    ...Array.from({ length: 4 }, (_, lane) => vectorReplaceDefinition(lane)),
    vectorReduceAddDefinition(),
    vectorMapDefinition(),
    vectorZipDefinition(),
    vectorFoldDefinition(),
  ]);

export const f32x4: Readonly<{
  readonly type: TypeSchema;
  readonly maskType: TypeSchema;
  make(
    lanes: readonly [
      SurfaceExpression,
      SurfaceExpression,
      SurfaceExpression,
      SurfaceExpression,
    ],
  ): SurfaceExpression;
  splat(value: SurfaceExpression): SurfaceExpression;
  add(
    left: SurfaceExpression,
    right: SurfaceExpression,
  ): SurfaceExpression;
  subtract(
    left: SurfaceExpression,
    right: SurfaceExpression,
  ): SurfaceExpression;
  multiply(
    left: SurfaceExpression,
    right: SurfaceExpression,
  ): SurfaceExpression;
  divide(
    left: SurfaceExpression,
    right: SurfaceExpression,
  ): SurfaceExpression;
  equal(
    left: SurfaceExpression,
    right: SurfaceExpression,
  ): SurfaceExpression;
  less(
    left: SurfaceExpression,
    right: SurfaceExpression,
  ): SurfaceExpression;
  select(
    mask: SurfaceExpression,
    whenTrue: SurfaceExpression,
    whenFalse: SurfaceExpression,
  ): SurfaceExpression;
  extractLane(vector: SurfaceExpression, lane: number): SurfaceExpression;
  replaceLane(
    vector: SurfaceExpression,
    lane: number,
    value: SurfaceExpression,
  ): SurfaceExpression;
  reduceAdd(vector: SurfaceExpression): SurfaceExpression;
  map(
    transform: SurfaceExpression,
    vector: SurfaceExpression,
  ): SurfaceExpression;
  zip(
    combine: SurfaceExpression,
    left: SurfaceExpression,
    right: SurfaceExpression,
  ): SurfaceExpression;
  fold(
    combine: SurfaceExpression,
    initial: SurfaceExpression,
    vector: SurfaceExpression,
  ): SurfaceExpression;
}> = Object.freeze({
  type: F32X4_TYPE,
  maskType: MASK32X4_TYPE,
  make: f32x4Constructor,
  splat: (value) => vectorCall(F32x4Definition.Splat, [value]),
  add: (left, right) => vectorCall(F32x4Definition.Add, [left, right]),
  subtract: (left, right) => vectorCall(F32x4Definition.Subtract, [left, right]),
  multiply: (left, right) => vectorCall(F32x4Definition.Multiply, [left, right]),
  divide: (left, right) => vectorCall(F32x4Definition.Divide, [left, right]),
  equal: (left, right) => vectorCall(F32x4Definition.Equal, [left, right]),
  less: (left, right) => vectorCall(F32x4Definition.Less, [left, right]),
  select: (mask, whenTrue, whenFalse) =>
    vectorCall(F32x4Definition.Select, [mask, whenTrue, whenFalse]),
  extractLane(vector, lane) {
    return vectorCall(extractDefinition(lane), [vector]);
  },
  replaceLane(vector, lane, value) {
    return vectorCall(replaceDefinition(lane), [vector, value]);
  },
  reduceAdd: (vector) => vectorCall(F32x4Definition.ReduceAdd, [vector]),
  map: (transform, vector) => vectorCall(F32x4Definition.Map, [transform, vector]),
  zip: (combine, left, right) => vectorCall(F32x4Definition.Zip, [combine, left, right]),
  fold: (combine, initial, vector) => vectorCall(F32x4Definition.Fold, [combine, initial, vector]),
});

function vectorBinaryDefinition(
  name: string,
  operator: BinaryOperatorValue,
): SurfaceDefinition {
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
  operator: BinaryOperatorValue,
): SurfaceDefinition {
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

function vectorSelectDefinition(): SurfaceDefinition {
  return vectorDefinition(
    F32x4Definition.Select,
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

function vectorExtractDefinition(lane: number): SurfaceDefinition {
  return vectorDefinition(
    extractDefinition(lane),
    ["vector"],
    functionType([F32X4_TYPE], FLOAT32_TYPE),
    f32x4Case("vector", "lane", (lanes) => lanes[lane]!),
  );
}

function vectorReplaceDefinition(lane: number): SurfaceDefinition {
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

function vectorReduceAddDefinition(): SurfaceDefinition {
  return vectorDefinition(
    F32x4Definition.ReduceAdd,
    ["vector"],
    functionType([F32X4_TYPE], FLOAT32_TYPE),
    f32x4Case("vector", "lane", ([lane0, lane1, lane2, lane3]) =>
      surface.binary(
        BinaryOperator.AddFloat32,
        surface.binary(BinaryOperator.AddFloat32, lane0!, lane1!),
        surface.binary(BinaryOperator.AddFloat32, lane2!, lane3!),
      )),
  );
}

function vectorMapDefinition(): SurfaceDefinition {
  const transformType = functionType([FLOAT32_TYPE], FLOAT32_TYPE);
  return vectorDefinition(
    F32x4Definition.Map,
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

function vectorZipDefinition(): SurfaceDefinition {
  const combineType = functionType([FLOAT32_TYPE, FLOAT32_TYPE], FLOAT32_TYPE);
  return vectorDefinition(
    F32x4Definition.Zip,
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

function vectorFoldDefinition(): SurfaceDefinition {
  const combineType = functionType([FLOAT32_TYPE, FLOAT32_TYPE], FLOAT32_TYPE);
  return vectorDefinition(
    F32x4Definition.Fold,
    ["combine", "initial", "vector"],
    functionType([combineType, FLOAT32_TYPE, F32X4_TYPE], FLOAT32_TYPE),
    f32x4Case("vector", "lane", (lanes) =>
      lanes.reduce<SurfaceExpression>(
        (accumulator, lane) => surface.apply(surface.name("combine"), accumulator, lane),
        surface.name("initial"),
      )),
  );
}

function f32x4Case(
  value: string,
  binderPrefix: string,
  body: (lanes: readonly SurfaceExpression[]) => SurfaceExpression,
): SurfaceExpression {
  return vectorCase(F32X4_CONSTRUCTOR_NAME, value, binderPrefix, body);
}

function mask32x4Case(
  value: string,
  binderPrefix: string,
  body: (lanes: readonly SurfaceExpression[]) => SurfaceExpression,
): SurfaceExpression {
  return vectorCase(MASK32X4_CONSTRUCTOR_NAME, value, binderPrefix, body);
}

function vectorCase(
  constructor: string,
  value: string,
  binderPrefix: string,
  body: (lanes: readonly SurfaceExpression[]) => SurfaceExpression,
): SurfaceExpression {
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
  lanes: readonly SurfaceExpression[],
): SurfaceExpression {
  return vectorConstructor(F32X4_CONSTRUCTOR_NAME, lanes);
}

function mask32x4Constructor(
  lanes: readonly SurfaceExpression[],
): SurfaceExpression {
  return vectorConstructor(MASK32X4_CONSTRUCTOR_NAME, lanes);
}

function vectorConstructor(
  constructor: string,
  lanes: readonly SurfaceExpression[],
): SurfaceExpression {
  if (lanes.length !== 4) {
    throw new RangeError(`functional fixed vector requires 4 lanes; received ${lanes.length}`);
  }
  return surface.apply(surface.name(constructor), ...lanes);
}

function vectorCall(
  definition: string,
  arguments_: readonly SurfaceExpression[],
): SurfaceExpression {
  return surface.apply(surface.name(definition), ...arguments_);
}

function vectorDefinition(
  name: string,
  parameters: readonly string[],
  annotation: TypeSchema,
  body: SurfaceExpression,
): SurfaceDefinition {
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
  parameters: readonly TypeSchema[],
  result: TypeSchema,
): TypeSchema {
  return parameters.reduceRight<TypeSchema>(
    (body, parameter) => Object.freeze({ kind: "function", parameter, result: body }),
    result,
  );
}

function extractDefinition(lane: number): string {
  requireLane(lane);
  return [
    F32x4Definition.ExtractLane0,
    F32x4Definition.ExtractLane1,
    F32x4Definition.ExtractLane2,
    F32x4Definition.ExtractLane3,
  ][lane]!;
}

function replaceDefinition(lane: number): string {
  requireLane(lane);
  return [
    F32x4Definition.ReplaceLane0,
    F32x4Definition.ReplaceLane1,
    F32x4Definition.ReplaceLane2,
    F32x4Definition.ReplaceLane3,
  ][lane]!;
}

function requireLane(lane: number): void {
  if (Number.isInteger(lane) && lane >= 0 && lane < 4) return;
  throw new RangeError(`functional F32x4 lane must be an integer within [0, 3]; received ${lane}`);
}
