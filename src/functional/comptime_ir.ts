import {
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  FunctionalNumericConversion,
  type FunctionalTypeSchema,
  FunctionalUnaryOperator,
} from "./abi.ts";
import {
  FUNCTIONAL_COMPTIME_BYTE_LIST_NAME,
  FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPES,
  functionalComptimeBytesFromConstant,
  functionalComptimeStringFromConstant,
  functionalConstantFromComptimeBytes,
  functionalConstantFromComptimeString,
  validateFunctionalConstant,
} from "./comptime_constant.ts";
import type { FunctionalConstant } from "./comptime_contract.ts";
import {
  createFunctionalModuleArtifact,
  type FunctionalModuleArtifact,
  type FunctionalModuleExport,
} from "./module_linker.ts";
import type {
  FunctionalSurfaceCaseArm,
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "./surface_builder.ts";

export const FUNCTIONAL_COMPTIME_IR_EXPRESSION_NAME = "$ComptimeFunctionalExpression";
export const FUNCTIONAL_COMPTIME_IR_DEFINITION_LIST_NAME = "$ComptimeFunctionalDefinitionList";

const NAME_LIST = "$ComptimeFunctionalNameList";
const CASE_ARM = "$ComptimeFunctionalCaseArm";
const CASE_ARM_LIST = "$ComptimeFunctionalCaseArmList";
const DEFINITION = "$ComptimeFunctionalDefinition";
const NAME_NIL = "$ComptimeFunctionalNameNil";
const NAME_CONS = "$ComptimeFunctionalNameCons";
const CASE_ARM_VALUE = "$ComptimeFunctionalCaseArmValue";
const CASE_ARM_NIL = "$ComptimeFunctionalCaseArmNil";
const CASE_ARM_CONS = "$ComptimeFunctionalCaseArmCons";
const DEFINITION_VALUE = "$ComptimeFunctionalDefinitionValue";
const DEFINITION_NIL = "$ComptimeFunctionalDefinitionNil";
const DEFINITION_CONS = "$ComptimeFunctionalDefinitionCons";
const EXPRESSION_INTEGER = "$ComptimeFunctionalInteger";
const EXPRESSION_SIGNED_INTEGER_64 = "$ComptimeFunctionalSignedInteger64";
const EXPRESSION_FLOAT_32 = "$ComptimeFunctionalFloat32";
const EXPRESSION_FLOAT_64 = "$ComptimeFunctionalFloat64";
const EXPRESSION_BOOLEAN = "$ComptimeFunctionalBoolean";
const EXPRESSION_TEXT = "$ComptimeFunctionalText";
const EXPRESSION_BYTES = "$ComptimeFunctionalBytes";
const EXPRESSION_RUNTIME_FAULT = "$ComptimeFunctionalRuntimeFault";
const EXPRESSION_NAME = "$ComptimeFunctionalName";
const EXPRESSION_LAMBDA = "$ComptimeFunctionalLambda";
const EXPRESSION_LET = "$ComptimeFunctionalLet";
const EXPRESSION_LET_REC = "$ComptimeFunctionalLetRec";
const EXPRESSION_IF = "$ComptimeFunctionalIf";
const EXPRESSION_APPLY = "$ComptimeFunctionalApply";
const EXPRESSION_UNARY = "$ComptimeFunctionalUnary";
const EXPRESSION_BINARY = "$ComptimeFunctionalBinary";
const EXPRESSION_CONVERT = "$ComptimeFunctionalNumericConvert";
const EXPRESSION_CASE = "$ComptimeFunctionalCase";

const byteString: FunctionalTypeSchema = {
  kind: "named",
  name: FUNCTIONAL_COMPTIME_BYTE_LIST_NAME,
  arguments: [],
};
const expression: FunctionalTypeSchema = {
  kind: "named",
  name: FUNCTIONAL_COMPTIME_IR_EXPRESSION_NAME,
  arguments: [],
};
const nameList: FunctionalTypeSchema = { kind: "named", name: NAME_LIST, arguments: [] };
const caseArm: FunctionalTypeSchema = { kind: "named", name: CASE_ARM, arguments: [] };
const caseArmList: FunctionalTypeSchema = { kind: "named", name: CASE_ARM_LIST, arguments: [] };
const definition: FunctionalTypeSchema = { kind: "named", name: DEFINITION, arguments: [] };
const definitionList: FunctionalTypeSchema = {
  kind: "named",
  name: FUNCTIONAL_COMPTIME_IR_DEFINITION_LIST_NAME,
  arguments: [],
};

export const FUNCTIONAL_COMPTIME_IR_SCHEMA: FunctionalTypeSchema = Object.freeze(definitionList);

export const FUNCTIONAL_COMPTIME_IR_TYPES: readonly FunctionalSurfaceTypeDeclaration[] = Object
  .freeze([
    FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPES.find((declaration) =>
      declaration.name === FUNCTIONAL_COMPTIME_BYTE_LIST_NAME
    )!,
    {
      name: NAME_LIST,
      parameters: [],
      constructors: [
        { name: NAME_NIL, fields: [] },
        {
          name: NAME_CONS,
          fields: [
            { name: "name", type: byteString },
            { name: "rest", type: nameList },
          ],
        },
      ],
    },
    {
      name: CASE_ARM,
      parameters: [],
      constructors: [{
        name: CASE_ARM_VALUE,
        fields: [
          { name: "constructor", type: byteString },
          { name: "binders", type: nameList },
          { name: "body", type: expression },
        ],
      }],
    },
    {
      name: CASE_ARM_LIST,
      parameters: [],
      constructors: [
        { name: CASE_ARM_NIL, fields: [] },
        {
          name: CASE_ARM_CONS,
          fields: [
            { name: "arm", type: caseArm },
            { name: "rest", type: caseArmList },
          ],
        },
      ],
    },
    {
      name: FUNCTIONAL_COMPTIME_IR_EXPRESSION_NAME,
      parameters: [],
      constructors: [
        { name: EXPRESSION_INTEGER, fields: [{ name: "value", type: { kind: "integer" } }] },
        {
          name: EXPRESSION_SIGNED_INTEGER_64,
          fields: [{ name: "value", type: { kind: "signed-integer-64" } }],
        },
        { name: EXPRESSION_FLOAT_32, fields: [{ name: "value", type: { kind: "float-32" } }] },
        { name: EXPRESSION_FLOAT_64, fields: [{ name: "value", type: { kind: "float-64" } }] },
        { name: EXPRESSION_BOOLEAN, fields: [{ name: "value", type: { kind: "boolean" } }] },
        { name: EXPRESSION_TEXT, fields: [{ name: "value", type: byteString }] },
        { name: EXPRESSION_BYTES, fields: [{ name: "value", type: byteString }] },
        { name: EXPRESSION_RUNTIME_FAULT, fields: [{ name: "message", type: byteString }] },
        { name: EXPRESSION_NAME, fields: [{ name: "name", type: byteString }] },
        {
          name: EXPRESSION_LAMBDA,
          fields: [{ name: "parameter", type: byteString }, { name: "body", type: expression }],
        },
        {
          name: EXPRESSION_LET,
          fields: [
            { name: "name", type: byteString },
            { name: "value", type: expression },
            { name: "body", type: expression },
            { name: "evaluation", type: { kind: "integer" } },
          ],
        },
        {
          name: EXPRESSION_LET_REC,
          fields: [
            { name: "name", type: byteString },
            { name: "value", type: expression },
            { name: "body", type: expression },
          ],
        },
        {
          name: EXPRESSION_IF,
          fields: [
            { name: "condition", type: expression },
            { name: "consequent", type: expression },
            { name: "alternate", type: expression },
          ],
        },
        {
          name: EXPRESSION_APPLY,
          fields: [
            { name: "callee", type: expression },
            { name: "argument", type: expression },
            { name: "evaluation", type: { kind: "integer" } },
          ],
        },
        {
          name: EXPRESSION_UNARY,
          fields: [
            { name: "operator", type: { kind: "integer" } },
            { name: "value", type: expression },
          ],
        },
        {
          name: EXPRESSION_BINARY,
          fields: [
            { name: "operator", type: { kind: "integer" } },
            { name: "left", type: expression },
            { name: "right", type: expression },
          ],
        },
        {
          name: EXPRESSION_CONVERT,
          fields: [
            { name: "conversion", type: { kind: "integer" } },
            { name: "value", type: expression },
          ],
        },
        {
          name: EXPRESSION_CASE,
          fields: [{ name: "value", type: expression }, { name: "arms", type: caseArmList }],
        },
      ],
    },
    {
      name: DEFINITION,
      parameters: [],
      constructors: [{
        name: DEFINITION_VALUE,
        fields: [
          { name: "name", type: byteString },
          { name: "parameters", type: nameList },
          { name: "body", type: expression },
        ],
      }],
    },
    {
      name: FUNCTIONAL_COMPTIME_IR_DEFINITION_LIST_NAME,
      parameters: [],
      constructors: [
        { name: DEFINITION_NIL, fields: [] },
        {
          name: DEFINITION_CONS,
          fields: [
            { name: "definition", type: definition },
            { name: "rest", type: definitionList },
          ],
        },
      ],
    },
  ]);

export interface FunctionalGeneratedDefinition {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly body: FunctionalSurfaceExpression;
}

export function functionalConstantFromSurfaceExpression(
  value: FunctionalSurfaceExpression,
): FunctionalConstant {
  switch (value.kind) {
    case "integer":
      return constructor(EXPRESSION_INTEGER, [{ kind: "integer", value: value.value }]);
    case "signed-integer-64":
      return constructor(EXPRESSION_SIGNED_INTEGER_64, [
        { kind: "signed-integer-64", value: value.value },
      ]);
    case "float-32":
      return constructor(EXPRESSION_FLOAT_32, [{ kind: "float-32", value: value.value }]);
    case "float-64":
      return constructor(EXPRESSION_FLOAT_64, [{ kind: "float-64", value: value.value }]);
    case "boolean":
      return constructor(EXPRESSION_BOOLEAN, [{ kind: "boolean", value: value.value }]);
    case "text":
      return constructor(EXPRESSION_TEXT, [functionalConstantFromComptimeString(value.value)]);
    case "bytes":
      return constructor(EXPRESSION_BYTES, [functionalConstantFromComptimeBytes(value.value)]);
    case "runtime-fault":
      return constructor(EXPRESSION_RUNTIME_FAULT, [
        functionalConstantFromComptimeString(value.message),
      ]);
    case "name":
      return constructor(EXPRESSION_NAME, [functionalConstantFromComptimeString(value.name)]);
    case "lambda":
      return constructor(EXPRESSION_LAMBDA, [
        functionalConstantFromComptimeString(value.parameter),
        functionalConstantFromSurfaceExpression(value.body),
      ]);
    case "let":
      return constructor(EXPRESSION_LET, [
        functionalConstantFromComptimeString(value.name),
        functionalConstantFromSurfaceExpression(value.value),
        functionalConstantFromSurfaceExpression(value.body),
        { kind: "integer", value: encodedEvaluationProfile(value.valueEvaluation) },
      ]);
    case "let-rec":
      return constructor(EXPRESSION_LET_REC, [
        functionalConstantFromComptimeString(value.name),
        functionalConstantFromSurfaceExpression(value.value),
        functionalConstantFromSurfaceExpression(value.body),
      ]);
    case "let-rec-group":
      throw new Error(
        "functional comptime IR requires recursive groups to be elaborated before encoding",
      );
    case "if":
      return constructor(EXPRESSION_IF, [
        functionalConstantFromSurfaceExpression(value.condition),
        functionalConstantFromSurfaceExpression(value.consequent),
        functionalConstantFromSurfaceExpression(value.alternate),
      ]);
    case "apply":
      return constructor(EXPRESSION_APPLY, [
        functionalConstantFromSurfaceExpression(value.callee),
        functionalConstantFromSurfaceExpression(value.argument),
        { kind: "integer", value: encodedEvaluationProfile(value.argumentEvaluation) },
      ]);
    case "unary":
      return constructor(EXPRESSION_UNARY, [
        { kind: "integer", value: value.operator },
        functionalConstantFromSurfaceExpression(value.value),
      ]);
    case "binary":
      return constructor(EXPRESSION_BINARY, [
        { kind: "integer", value: value.operator },
        functionalConstantFromSurfaceExpression(value.left),
        functionalConstantFromSurfaceExpression(value.right),
      ]);
    case "numeric-convert":
      return constructor(EXPRESSION_CONVERT, [
        { kind: "integer", value: value.conversion },
        functionalConstantFromSurfaceExpression(value.value),
      ]);
    case "case":
      return constructor(EXPRESSION_CASE, [
        functionalConstantFromSurfaceExpression(value.value),
        encodedCaseArms(value.arms),
      ]);
  }
}

export function functionalSurfaceExpressionFromConstant(
  constant: FunctionalConstant,
): FunctionalSurfaceExpression {
  validateFunctionalConstant(constant);
  return decodedExpression(constant);
}

export function functionalConstantFromGeneratedDefinitions(
  definitions: readonly FunctionalGeneratedDefinition[],
): FunctionalConstant {
  let result = constructor(DEFINITION_NIL);
  for (let index = definitions.length - 1; index >= 0; index--) {
    const current = definitions[index]!;
    result = constructor(DEFINITION_CONS, [
      constructor(DEFINITION_VALUE, [
        functionalConstantFromComptimeString(current.name),
        encodedNames(current.parameters),
        functionalConstantFromSurfaceExpression(current.body),
      ]),
      result,
    ]);
  }
  return result;
}

export function functionalGeneratedDefinitionsFromConstant(
  constant: FunctionalConstant,
): readonly FunctionalGeneratedDefinition[] {
  validateFunctionalConstant(constant);
  const definitions: FunctionalGeneratedDefinition[] = [];
  let current = constant;
  while (isConstructor(current, DEFINITION_CONS)) {
    const fields = requiredFields(
      requiredConstructor(current, DEFINITION_CONS),
      DEFINITION_CONS,
      2,
    );
    const encodedDefinition = requiredConstructor(fields[0]!, DEFINITION_VALUE);
    const definitionFields = requiredFields(encodedDefinition, DEFINITION_VALUE, 3);
    definitions.push(Object.freeze({
      name: requiredName(definitionFields[0]!, "generated definition name"),
      parameters: Object.freeze(decodedNames(definitionFields[1]!)),
      body: decodedExpression(definitionFields[2]!),
    }));
    current = fields[1]!;
  }
  requiredFields(requiredConstructor(current, DEFINITION_NIL), DEFINITION_NIL, 0);
  return Object.freeze(definitions);
}

export function spliceFunctionalGeneratedDefinitions(
  artifact: FunctionalModuleArtifact,
  encodedDefinitions: FunctionalConstant,
  exports: readonly FunctionalModuleExport[] = [],
): FunctionalModuleArtifact {
  const definitions = functionalGeneratedDefinitionsFromConstant(encodedDefinitions).map((value) =>
    Object.freeze({
      name: value.name,
      parameters: value.parameters,
      annotation: null,
      body: value.body,
    }) satisfies FunctionalSurfaceDefinition
  );
  return createFunctionalModuleArtifact({
    ...artifact,
    definitions: [...artifact.definitions, ...definitions],
    exports: [...artifact.exports, ...exports],
  });
}

function decodedExpression(constant: FunctionalConstant): FunctionalSurfaceExpression {
  const encoded = requiredConstructor(constant, "functional expression");
  const name = unqualifiedConstructorName(encoded.name);
  switch (name) {
    case EXPRESSION_INTEGER:
      return { kind: "integer", value: requiredNumber(encoded, name, "integer") };
    case EXPRESSION_SIGNED_INTEGER_64:
      return {
        kind: "signed-integer-64",
        value: requiredSignedInteger64(encoded, name),
      };
    case EXPRESSION_FLOAT_32:
      return { kind: "float-32", value: requiredNumber(encoded, name, "float-32") };
    case EXPRESSION_FLOAT_64:
      return { kind: "float-64", value: requiredNumber(encoded, name, "float-64") };
    case EXPRESSION_BOOLEAN:
      return { kind: "boolean", value: requiredBoolean(encoded, name) };
    case EXPRESSION_TEXT:
      return {
        kind: "text",
        value: functionalComptimeStringFromConstant(requiredFields(encoded, name, 1)[0]!),
      };
    case EXPRESSION_BYTES:
      return {
        kind: "bytes",
        value: functionalComptimeBytesFromConstant(requiredFields(encoded, name, 1)[0]!),
      };
    case EXPRESSION_RUNTIME_FAULT:
      return {
        kind: "runtime-fault",
        message: functionalComptimeStringFromConstant(requiredFields(encoded, name, 1)[0]!),
      };
    case EXPRESSION_NAME:
      return { kind: "name", name: requiredName(requiredFields(encoded, name, 1)[0]!, "name") };
    case EXPRESSION_LAMBDA: {
      const fields = requiredFields(encoded, name, 2);
      return {
        kind: "lambda",
        parameter: requiredName(fields[0]!, "lambda parameter"),
        body: decodedExpression(fields[1]!),
      };
    }
    case EXPRESSION_LET: {
      const fields = requiredFields(encoded, name, 4);
      const evaluation = decodedEvaluationProfile(requiredInteger(fields[3]!, "let evaluation"));
      return {
        kind: "let",
        name: requiredName(fields[0]!, "let name"),
        value: decodedExpression(fields[1]!),
        body: decodedExpression(fields[2]!),
        ...(evaluation === undefined ? {} : { valueEvaluation: evaluation }),
      };
    }
    case EXPRESSION_LET_REC: {
      const fields = requiredFields(encoded, name, 3);
      return {
        kind: "let-rec",
        name: requiredName(fields[0]!, "recursive let name"),
        value: decodedExpression(fields[1]!),
        body: decodedExpression(fields[2]!),
      };
    }
    case EXPRESSION_IF: {
      const fields = requiredFields(encoded, name, 3);
      return {
        kind: "if",
        condition: decodedExpression(fields[0]!),
        consequent: decodedExpression(fields[1]!),
        alternate: decodedExpression(fields[2]!),
      };
    }
    case EXPRESSION_APPLY: {
      const fields = requiredFields(encoded, name, 3);
      const evaluation = decodedEvaluationProfile(requiredInteger(fields[2]!, "apply evaluation"));
      return {
        kind: "apply",
        callee: decodedExpression(fields[0]!),
        argument: decodedExpression(fields[1]!),
        ...(evaluation === undefined ? {} : { argumentEvaluation: evaluation }),
      };
    }
    case EXPRESSION_UNARY: {
      const fields = requiredFields(encoded, name, 2);
      const operator = requiredInteger(fields[0]!, "unary operator");
      if (!(Object.values(FunctionalUnaryOperator) as readonly number[]).includes(operator)) {
        throw new TypeError(`functional generated IR uses unknown unary operator ${operator}`);
      }
      return {
        kind: "unary",
        operator: operator as FunctionalUnaryOperator,
        value: decodedExpression(fields[1]!),
      };
    }
    case EXPRESSION_BINARY: {
      const fields = requiredFields(encoded, name, 3);
      const operator = requiredInteger(fields[0]!, "binary operator");
      if (!(Object.values(FunctionalBinaryOperator) as readonly number[]).includes(operator)) {
        throw new TypeError(`functional generated IR uses unknown binary operator ${operator}`);
      }
      return {
        kind: "binary",
        operator: operator as FunctionalBinaryOperator,
        left: decodedExpression(fields[1]!),
        right: decodedExpression(fields[2]!),
      };
    }
    case EXPRESSION_CONVERT: {
      const fields = requiredFields(encoded, name, 2);
      const conversion = requiredInteger(fields[0]!, "numeric conversion");
      if (!(Object.values(FunctionalNumericConversion) as readonly number[]).includes(conversion)) {
        throw new TypeError(
          `functional generated IR uses unknown numeric conversion ${conversion}`,
        );
      }
      return {
        kind: "numeric-convert",
        conversion: conversion as FunctionalNumericConversion,
        value: decodedExpression(fields[1]!),
      };
    }
    case EXPRESSION_CASE: {
      const fields = requiredFields(encoded, name, 2);
      return {
        kind: "case",
        value: decodedExpression(fields[0]!),
        arms: decodedCaseArms(fields[1]!),
      };
    }
    default:
      throw new TypeError(
        `functional generated IR uses unexpected expression constructor ${JSON.stringify(name)}`,
      );
  }
}

function encodedCaseArms(arms: readonly FunctionalSurfaceCaseArm[]): FunctionalConstant {
  let result = constructor(CASE_ARM_NIL);
  for (let index = arms.length - 1; index >= 0; index--) {
    const arm = arms[index]!;
    result = constructor(CASE_ARM_CONS, [
      constructor(CASE_ARM_VALUE, [
        functionalConstantFromComptimeString(arm.constructor),
        encodedNames(arm.binders),
        functionalConstantFromSurfaceExpression(arm.body),
      ]),
      result,
    ]);
  }
  return result;
}

function decodedCaseArms(constant: FunctionalConstant): readonly FunctionalSurfaceCaseArm[] {
  const arms: FunctionalSurfaceCaseArm[] = [];
  let current = constant;
  while (isConstructor(current, CASE_ARM_CONS)) {
    const fields = requiredFields(requiredConstructor(current, CASE_ARM_CONS), CASE_ARM_CONS, 2);
    const encodedArm = requiredConstructor(fields[0]!, CASE_ARM_VALUE);
    const armFields = requiredFields(encodedArm, CASE_ARM_VALUE, 3);
    arms.push(Object.freeze({
      constructor: requiredName(armFields[0]!, "case constructor"),
      binders: Object.freeze(decodedNames(armFields[1]!)),
      body: decodedExpression(armFields[2]!),
    }));
    current = fields[1]!;
  }
  requiredFields(requiredConstructor(current, CASE_ARM_NIL), CASE_ARM_NIL, 0);
  return Object.freeze(arms);
}

function encodedNames(names: readonly string[]): FunctionalConstant {
  let result = constructor(NAME_NIL);
  for (let index = names.length - 1; index >= 0; index--) {
    result = constructor(NAME_CONS, [functionalConstantFromComptimeString(names[index]!), result]);
  }
  return result;
}

function decodedNames(constant: FunctionalConstant): string[] {
  const names: string[] = [];
  let current = constant;
  while (isConstructor(current, NAME_CONS)) {
    const fields = requiredFields(requiredConstructor(current, NAME_CONS), NAME_CONS, 2);
    names.push(requiredName(fields[0]!, "generated parameter"));
    current = fields[1]!;
  }
  requiredFields(requiredConstructor(current, NAME_NIL), NAME_NIL, 0);
  return names;
}

function requiredName(constant: FunctionalConstant, location: string): string {
  const name = functionalComptimeStringFromConstant(constant);
  if (name.length > 0) return name;
  throw new TypeError(`functional generated IR ${location} must be nonempty`);
}

function encodedEvaluationProfile(profile: FunctionalEvaluationProfile | undefined): number {
  if (profile === undefined) return 0;
  if (profile === FunctionalEvaluationProfile.LazyCallByNeed) return 1;
  if (profile === FunctionalEvaluationProfile.StrictEager) return 2;
  throw new TypeError(
    `functional generated IR uses unknown evaluation profile ${JSON.stringify(profile)}`,
  );
}

function decodedEvaluationProfile(value: number): FunctionalEvaluationProfile | undefined {
  if (value === 0) return undefined;
  if (value === 1) return FunctionalEvaluationProfile.LazyCallByNeed;
  if (value === 2) return FunctionalEvaluationProfile.StrictEager;
  throw new TypeError(`functional generated IR uses unknown evaluation profile ${value}`);
}

function constructor(name: string, fields: readonly FunctionalConstant[] = []): FunctionalConstant {
  return Object.freeze({ kind: "constructor", name, fields: Object.freeze([...fields]) });
}

function requiredConstructor(
  constant: FunctionalConstant,
  expected: string,
): Extract<FunctionalConstant, { readonly kind: "constructor" }> {
  if (constant.kind !== "constructor") {
    throw new TypeError(
      `functional generated IR ${expected} requires a constructor; received ${constant.kind}`,
    );
  }
  if (expected !== "functional expression" && !constructorMatches(constant.name, expected)) {
    throw new TypeError(
      `functional generated IR expected ${JSON.stringify(expected)}; received ${
        JSON.stringify(constant.name)
      }`,
    );
  }
  return constant;
}

function requiredFields(
  constant: Extract<FunctionalConstant, { readonly kind: "constructor" }>,
  name: string,
  count: number,
): readonly FunctionalConstant[] {
  if (constant.fields.length === count) return constant.fields;
  throw new TypeError(
    `functional generated IR constructor ${
      JSON.stringify(name)
    } has ${constant.fields.length} fields; expected ${count}`,
  );
}

function requiredInteger(constant: FunctionalConstant, location: string): number {
  if (constant.kind === "integer") return constant.value;
  throw new TypeError(
    `functional generated IR ${location} requires an integer; received ${constant.kind}`,
  );
}

function requiredNumber(
  constant: Extract<FunctionalConstant, { readonly kind: "constructor" }>,
  name: string,
  kind: "integer" | "float-32" | "float-64",
): number {
  const field = requiredFields(constant, name, 1)[0];
  if (field?.kind === kind) {
    return field.value;
  }
  throw new TypeError(
    `functional generated IR constructor ${JSON.stringify(name)} requires ${kind}; received ${
      field?.kind ?? "missing"
    }`,
  );
}

function requiredSignedInteger64(
  constant: Extract<FunctionalConstant, { readonly kind: "constructor" }>,
  name: string,
): bigint {
  const field = requiredFields(constant, name, 1)[0];
  if (field?.kind === "signed-integer-64") return field.value;
  throw new TypeError(
    `functional generated IR constructor ${
      JSON.stringify(name)
    } requires signed-integer-64; received ${field?.kind ?? "missing"}`,
  );
}

function requiredBoolean(
  constant: Extract<FunctionalConstant, { readonly kind: "constructor" }>,
  name: string,
): boolean {
  const field = requiredFields(constant, name, 1)[0];
  if (field?.kind === "boolean") return field.value;
  throw new TypeError(
    `functional generated IR constructor ${JSON.stringify(name)} requires boolean; received ${
      field?.kind ?? "missing"
    }`,
  );
}

function isConstructor(constant: FunctionalConstant, expected: string): boolean {
  return constant.kind === "constructor" && constructorMatches(constant.name, expected);
}

function constructorMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`::${expected}`);
}

function unqualifiedConstructorName(name: string): string {
  const separator = name.lastIndexOf("::");
  return separator < 0 ? name : name.slice(separator + 2);
}
