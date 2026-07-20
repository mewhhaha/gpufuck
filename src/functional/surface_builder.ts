import {
  type EncodedFunctionalModule,
  FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
  FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  FUNCTIONAL_MAXIMUM_EXPRESSION_NODES,
  FUNCTIONAL_MODULE_ABI_VERSION,
  FUNCTIONAL_NO_INDEX,
  FUNCTIONAL_NODE_WORD_LENGTH,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_THUNK_CONSTRUCTOR_NAME,
  FUNCTIONAL_THUNK_TYPE_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  FunctionalExpressionTag,
  FunctionalNodeWord,
  type FunctionalNumericConversion,
  type FunctionalSourceType,
  type FunctionalSpan,
  FunctionalTypecheckingProfile,
  type FunctionalTypeSchema,
  FunctionalUnaryOperator,
} from "./abi.ts";
import {
  FUNCTIONAL_ARRAY_TYPE_NAME,
  FUNCTIONAL_BYTES_TYPE_NAME,
  FUNCTIONAL_ERASED_TYPE_NAME,
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_INIT_TYPE_NAME,
  FUNCTIONAL_RESOURCE_TYPE_PREFIX,
  FUNCTIONAL_SLICE_TYPE_NAME,
  FUNCTIONAL_TEXT_TYPE_NAME,
  FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME,
  functionalHostFieldRepresentationType,
  functionalHostFieldType,
  type FunctionalSurfaceModuleOptions,
  normalizeFunctionalHostCapabilities,
} from "./host_contract.ts";
import { elaborateFunctionalRecursiveGroups } from "./recursive_groups.ts";
import { functionalBytesLiteralSymbol } from "./static_literals.ts";
import type {
  FunctionalSurfaceCaseArm,
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "./surface_contract.ts";

export type {
  FunctionalSurfaceCaseArm,
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceRecursiveBinding,
  FunctionalSurfaceRecursiveGroup,
  FunctionalSurfaceTypeDeclaration,
} from "./surface_contract.ts";

const SURFACE_FEATURE_RECURSIVE_GROUP = 1 << 0;
const SURFACE_FEATURE_EXPLICIT_THUNK = 1 << 1;
const MAXIMUM_SURFACE_STRUCTURE_DEPTH = 512;
const MAXIMUM_SURFACE_TYPE_NODES = 4_096;

interface SurfaceTypeTraversal {
  readonly activeTypes: WeakSet<object>;
  remainingNodes: number;
}

interface SurfaceExpressionTraversal {
  readonly activeExpressions: WeakSet<object>;
  remainingNodes: number;
}

export function functionalThunkType(value: FunctionalTypeSchema): FunctionalTypeSchema {
  return {
    kind: "named",
    name: FUNCTIONAL_THUNK_TYPE_NAME,
    arguments: [value],
  };
}

export function buildFunctionalSurfaceModule(
  definitions: readonly FunctionalSurfaceDefinition[],
  typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[],
  entryName: string,
  sourceByteLength: number,
  options: FunctionalSurfaceModuleOptions = {},
): EncodedFunctionalModule {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("functional surface module options must be an object");
  }
  for (const [definitionIndex, definition] of definitions.entries()) {
    if (definition.annotation !== null) {
      requireSurfaceTypeSchema(
        definition.annotation,
        `definition ${definitionIndex} annotation`,
      );
    }
  }
  for (const [typeIndex, declaration] of typeDeclarations.entries()) {
    for (const [constructorIndex, constructor] of declaration.constructors.entries()) {
      for (const [fieldIndex, field] of constructor.fields.entries()) {
        requireSurfaceTypeSchema(
          field.type,
          `type ${typeIndex} constructor ${constructorIndex} field ${fieldIndex}`,
        );
      }
      if (constructor.result !== undefined) {
        requireSurfaceTypeSchema(
          constructor.result,
          `type ${typeIndex} constructor ${constructorIndex} result`,
        );
      }
    }
  }
  let surfaceFeatures = 0;
  for (const definition of definitions) {
    surfaceFeatures |= expressionFeatureMask(definition.body);
  }
  const elaboratedDefinitions = surfaceFeatures & SURFACE_FEATURE_RECURSIVE_GROUP
    ? elaborateFunctionalRecursiveGroups(definitions)
    : definitions;
  if ((surfaceFeatures & SURFACE_FEATURE_RECURSIVE_GROUP) !== 0) {
    for (const definition of elaboratedDefinitions) expressionFeatureMask(definition.body);
  }
  const evaluationProfile = options.evaluationProfile ?? FunctionalEvaluationProfile.StrictEager;
  requireEvaluationProfile(evaluationProfile, "functional surface module");
  const hostCapabilities = normalizeFunctionalHostCapabilities(options.hostCapabilities);
  const hostDefinitions = normalizeHostDefinitions(
    elaboratedDefinitions,
    hostCapabilities,
    options.hostDefinitions,
  );
  const wasmExports = normalizeWasmExports(definitions, options.wasmExports);
  const usesHigherRankTypes =
    elaboratedDefinitions.some((definition) =>
      definition.annotation !== null && schemaContainsForall(definition.annotation)
    ) || typeDeclarations.some((declaration) =>
      declaration.constructors.some((constructor) =>
        constructor.fields.some((field) =>
          schemaContainsForall(field.type)
        ) ||
        constructor.result !== undefined && schemaContainsForall(constructor.result)
      )
    );
  const declaredNames = new Set(typeDeclarations.map((declaration) => declaration.name));
  for (const declaredName of declaredNames) {
    if (
      declaredName === "$UnitType" || declaredName === "$TupleType" ||
      declaredName === FUNCTIONAL_THUNK_TYPE_NAME ||
      declaredName === FUNCTIONAL_INIT_TYPE_NAME || declaredName === FUNCTIONAL_TEXT_TYPE_NAME ||
      declaredName === FUNCTIONAL_BYTES_TYPE_NAME || declaredName === FUNCTIONAL_ERASED_TYPE_NAME ||
      declaredName === FUNCTIONAL_ARRAY_TYPE_NAME ||
      declaredName === FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME ||
      declaredName === FUNCTIONAL_SLICE_TYPE_NAME ||
      declaredName.startsWith(FUNCTIONAL_RESOURCE_TYPE_PREFIX)
    ) {
      throw new Error(
        `functional surface cannot declare reserved type ${JSON.stringify(declaredName)}`,
      );
    }
  }
  const boundaryTypeNames = collectBoundaryTypeNames(
    elaboratedDefinitions,
    typeDeclarations,
    hostCapabilities,
  );
  const usesExplicitThunk = (surfaceFeatures & SURFACE_FEATURE_EXPLICIT_THUNK) !== 0;
  const encodedTypeDeclarations = [
    ...typeDeclarations,
    ...[...boundaryTypeNames].sort().map((name) => boundaryTypeDeclaration(name, sourceByteLength)),
    ...(hostCapabilities.length === 0
      ? []
      : [hostInitTypeDeclaration(hostCapabilities, sourceByteLength)]),
    ...primitiveTypeDeclarations(sourceByteLength, usesExplicitThunk),
  ];
  const symbols = new SurfaceSymbolTable();
  for (const definition of elaboratedDefinitions) symbols.intern(definition.name);
  symbols.intern(entryName);
  for (const declaration of encodedTypeDeclarations) {
    symbols.intern(declaration.name);
    for (const constructor of declaration.constructors) symbols.intern(constructor.name);
  }

  const typeIndices = new Map(
    encodedTypeDeclarations.map((declaration, index) => [declaration.name, index]),
  );
  const encoder = new SurfaceExpressionEncoder(symbols, typeIndices, evaluationProfile);
  const definitionWords: number[] = [];
  for (const definition of elaboratedDefinitions) {
    const rootNode = encoder.emitDefinitionBody(
      definition.parameters,
      definition.body,
      definition.span,
    );
    definitionWords.push(
      symbols.id(definition.name),
      rootNode,
      definition.span?.startByte ?? 0,
      definition.span?.endByte ?? 0,
    );
  }

  const typeWords: number[] = [];
  const constructorWords: number[] = [];
  for (const [typeIndex, declaration] of encodedTypeDeclarations.entries()) {
    const firstConstructor = constructorWords.length / FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH;
    typeWords.push(
      symbols.id(declaration.name),
      firstConstructor,
      declaration.constructors.length,
      declaration.span?.startByte ?? 0,
      declaration.span?.endByte ?? 0,
    );
    for (const constructor of declaration.constructors) {
      constructorWords.push(
        symbols.id(constructor.name),
        typeIndex,
        constructor.fields.length,
        constructor.span?.startByte ?? 0,
        constructor.span?.endByte ?? 0,
      );
    }
  }

  return {
    abiVersion: FUNCTIONAL_MODULE_ABI_VERSION,
    sourceByteLength,
    evaluationProfile,
    typecheckingProfile: usesHigherRankTypes
      ? FunctionalTypecheckingProfile.PredicativeRankNIndexed
      : FunctionalTypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
    hostCapabilities,
    hostDefinitions,
    wasmExports,
    nodeWords: Uint32Array.from(encoder.words),
    definitionWords: Uint32Array.from(definitionWords),
    typeWords: Uint32Array.from(typeWords),
    constructorWords: Uint32Array.from(constructorWords),
    nodeCount: encoder.nodeCount,
    definitionCount: elaboratedDefinitions.length,
    typeCount: encodedTypeDeclarations.length,
    constructorCount: constructorWords.length / FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
    entrySymbol: symbols.id(entryName),
    symbolNames: symbols.names,
    definitionTypes: elaboratedDefinitions.map((definition) => ({
      annotation: definition.annotation === null
        ? null
        : sourceType(definition.annotation, definition.span),
    })),
    typeDeclarations: encodedTypeDeclarations.map((declaration) => ({
      name: declaration.name,
      parameters: declaration.parameters,
      constructors: declaration.constructors.map((constructor) => ({
        name: constructor.name,
        fields: constructor.fields.map((field) => ({
          name: field.name,
          type: sourceType(field.type, field.span ?? constructor.span ?? declaration.span),
        })),
        ...(constructor.result === undefined
          ? {}
          : { result: sourceType(constructor.result, constructor.span ?? declaration.span) }),
      })),
    })),
  };
}

function requireSurfaceTypeSchema(
  schema: FunctionalTypeSchema,
  location: string,
  depth = 0,
  traversal: SurfaceTypeTraversal = {
    activeTypes: new WeakSet(),
    remainingNodes: MAXIMUM_SURFACE_TYPE_NODES,
  },
): void {
  if (depth > MAXIMUM_SURFACE_STRUCTURE_DEPTH) {
    throw new RangeError(
      `functional surface ${location} exceeds type depth ${MAXIMUM_SURFACE_STRUCTURE_DEPTH}`,
    );
  }
  if (traversal.remainingNodes === 0) {
    throw new RangeError(
      `functional surface ${location} exceeds ${MAXIMUM_SURFACE_TYPE_NODES} type nodes`,
    );
  }
  traversal.remainingNodes -= 1;
  if (schema === null || typeof schema !== "object" || typeof schema.kind !== "string") {
    throw new TypeError(`functional surface ${location} must be a type object`);
  }
  if (traversal.activeTypes.has(schema)) {
    throw new TypeError(`functional surface ${location} contains a structural type cycle`);
  }
  switch (schema.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return;
    case "parameter":
      if (typeof schema.name !== "string" || schema.name.length === 0) {
        throw new TypeError(`functional surface ${location} has an unnamed type parameter`);
      }
      return;
    case "tuple":
      if (!Array.isArray(schema.values) || schema.values.length !== 2) {
        throw new TypeError(`functional surface ${location} tuple must contain two values`);
      }
      traversal.activeTypes.add(schema);
      try {
        requireSurfaceTypeSchema(schema.values[0], location, depth + 1, traversal);
        requireSurfaceTypeSchema(schema.values[1], location, depth + 1, traversal);
      } finally {
        traversal.activeTypes.delete(schema);
      }
      return;
    case "named":
      if (typeof schema.name !== "string" || schema.name.length === 0) {
        throw new TypeError(`functional surface ${location} has an unnamed named type`);
      }
      if (!Array.isArray(schema.arguments)) {
        throw new TypeError(`functional surface ${location} named type arguments must be an array`);
      }
      traversal.activeTypes.add(schema);
      try {
        for (const argument of schema.arguments) {
          requireSurfaceTypeSchema(argument, location, depth + 1, traversal);
        }
      } finally {
        traversal.activeTypes.delete(schema);
      }
      return;
    case "function":
      traversal.activeTypes.add(schema);
      try {
        requireSurfaceTypeSchema(schema.parameter, location, depth + 1, traversal);
        requireSurfaceTypeSchema(schema.result, location, depth + 1, traversal);
      } finally {
        traversal.activeTypes.delete(schema);
      }
      return;
    case "forall": {
      if (!Array.isArray(schema.parameters) || schema.parameters.length === 0) {
        throw new TypeError(`functional surface ${location} forall needs type parameters`);
      }
      const parameters = new Set<string>();
      for (const [parameterIndex, parameter] of schema.parameters.entries()) {
        if (typeof parameter !== "string" || parameter.length === 0) {
          throw new TypeError(
            `functional surface ${location} forall parameter ${parameterIndex} must be named`,
          );
        }
        if (parameters.has(parameter)) {
          throw new TypeError(
            `functional surface ${location} repeats forall parameter ${JSON.stringify(parameter)}`,
          );
        }
        parameters.add(parameter);
      }
      traversal.activeTypes.add(schema);
      try {
        requireSurfaceTypeSchema(schema.body, location, depth + 1, traversal);
      } finally {
        traversal.activeTypes.delete(schema);
      }
      return;
    }
    default:
      throw new TypeError(
        `functional surface ${location} has unsupported type kind ${
          JSON.stringify((schema as { readonly kind: unknown }).kind)
        }`,
      );
  }
}

function normalizeHostDefinitions(
  definitions: readonly FunctionalSurfaceDefinition[],
  capabilities: ReturnType<typeof normalizeFunctionalHostCapabilities>,
  bindings: FunctionalSurfaceModuleOptions["hostDefinitions"],
): NonNullable<FunctionalSurfaceModuleOptions["hostDefinitions"]> {
  if (bindings === undefined) return Object.freeze([]);
  if (!Array.isArray(bindings)) {
    throw new TypeError("functional host definition bindings must be an array");
  }
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const boundDefinitions = new Set<string>();
  return Object.freeze(bindings.map((binding, index) => {
    if (binding === null || typeof binding !== "object") {
      throw new TypeError(
        `functional host definition binding ${index} must be an object; received ${
          JSON.stringify(binding)
        }`,
      );
    }
    const definition = definitionsByName.get(binding.definition);
    if (definition === undefined) {
      throw new Error(
        `functional host definition binding ${index} references missing definition ${
          JSON.stringify(binding.definition)
        }`,
      );
    }
    if (boundDefinitions.has(binding.definition)) {
      throw new Error(
        `functional host definition bindings repeat definition ${
          JSON.stringify(binding.definition)
        }`,
      );
    }
    const capability = capabilities.find((candidate) => candidate.name === binding.capability);
    const field = capability?.fields.find((candidate) => candidate.name === binding.field);
    if (field === undefined) {
      throw new Error(
        `functional host definition ${
          JSON.stringify(binding.definition)
        } references missing field ${JSON.stringify(`${binding.capability}.${binding.field}`)}`,
      );
    }
    const expectedType: FunctionalTypeSchema = field.kind === "value"
      ? field.type
      : { kind: "function", parameter: field.parameter, result: field.result };
    if (
      definition.annotation === null ||
      JSON.stringify(definition.annotation) !== JSON.stringify(expectedType)
    ) {
      throw new Error(
        `functional host definition ${JSON.stringify(binding.definition)} annotation ${
          JSON.stringify(definition.annotation)
        } does not match field ${JSON.stringify(`${binding.capability}.${binding.field}`)} type ${
          JSON.stringify(expectedType)
        }`,
      );
    }
    boundDefinitions.add(binding.definition);
    return Object.freeze({ ...binding });
  }));
}

function normalizeWasmExports(
  definitions: readonly FunctionalSurfaceDefinition[],
  declarations: FunctionalSurfaceModuleOptions["wasmExports"],
): readonly { readonly name: string; readonly definition: string }[] {
  if (declarations === undefined) return Object.freeze([]);
  if (!Array.isArray(declarations)) {
    throw new TypeError("functional WASM exports must be an array");
  }
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const names = new Set<string>();
  return Object.freeze(declarations.map((declaration, index) => {
    if (declaration === null || typeof declaration !== "object") {
      throw new TypeError(`functional WASM export ${index} must be an object`);
    }
    if (typeof declaration.name !== "string" || declaration.name.length === 0) {
      throw new Error(`functional WASM export ${index} name must be nonempty`);
    }
    if (
      [
        "main",
        "memory",
        "forceValue",
        "initialize",
        "allocate",
        "free",
        "heapTop",
        "freeListHead",
      ].includes(declaration.name)
    ) {
      throw new Error(
        `functional WASM export name ${JSON.stringify(declaration.name)} is reserved`,
      );
    }
    if (names.has(declaration.name)) {
      throw new Error(`functional WASM exports repeat name ${JSON.stringify(declaration.name)}`);
    }
    names.add(declaration.name);
    const definition = definitionsByName.get(declaration.definition);
    if (definition === undefined) {
      throw new Error(
        `functional WASM export ${JSON.stringify(declaration.name)} references unknown definition ${
          JSON.stringify(declaration.definition)
        }`,
      );
    }
    if (definition.annotation === null) {
      throw new Error(
        `functional WASM export ${
          JSON.stringify(declaration.name)
        } requires an annotated definition`,
      );
    }
    return Object.freeze({ name: declaration.name, definition: declaration.definition });
  }));
}

function schemaContainsForall(schema: FunctionalTypeSchema): boolean {
  switch (schema.kind) {
    case "forall":
      return true;
    case "tuple":
      return schemaContainsForall(schema.values[0]) || schemaContainsForall(schema.values[1]);
    case "named":
      return schema.arguments.some(schemaContainsForall);
    case "function":
      return schemaContainsForall(schema.parameter) || schemaContainsForall(schema.result);
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
    case "parameter":
      return false;
  }
}

function hostInitTypeDeclaration(
  capabilities: ReturnType<typeof normalizeFunctionalHostCapabilities>,
  sourceByteLength: number,
): FunctionalSurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return {
    name: FUNCTIONAL_INIT_TYPE_NAME,
    parameters: [],
    span,
    constructors: [{
      name: FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
      span,
      fields: capabilities.flatMap((capability) =>
        capability.fields.map((field) => ({
          name: `${capability.name}.${field.name}`,
          type: functionalHostFieldType(field),
          span,
        }))
      ),
    }],
  };
}

function collectBoundaryTypeNames(
  definitions: readonly FunctionalSurfaceDefinition[],
  typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[],
  capabilities: ReturnType<typeof normalizeFunctionalHostCapabilities>,
): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (schema: FunctionalTypeSchema): void => {
    if (schema.kind === "named") {
      if (
        schema.name === FUNCTIONAL_TEXT_TYPE_NAME || schema.name === FUNCTIONAL_BYTES_TYPE_NAME ||
        schema.name === FUNCTIONAL_ERASED_TYPE_NAME ||
        schema.name === FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME ||
        schema.name === FUNCTIONAL_ARRAY_TYPE_NAME || schema.name === FUNCTIONAL_SLICE_TYPE_NAME ||
        schema.name.startsWith(FUNCTIONAL_RESOURCE_TYPE_PREFIX)
      ) {
        names.add(schema.name);
      }
      for (const argument of schema.arguments) visit(argument);
      return;
    }
    if (schema.kind === "tuple") {
      visit(schema.values[0]);
      visit(schema.values[1]);
      return;
    }
    if (schema.kind === "function") {
      visit(schema.parameter);
      visit(schema.result);
      return;
    }
    if (schema.kind === "forall") visit(schema.body);
  };
  for (const definition of definitions) {
    if (definition.annotation !== null) visit(definition.annotation);
  }
  for (const declaration of typeDeclarations) {
    for (const constructor of declaration.constructors) {
      for (const field of constructor.fields) visit(field.type);
      if (constructor.result !== undefined) visit(constructor.result);
    }
  }
  const visitExpression = (expression: FunctionalSurfaceExpression): void => {
    switch (expression.kind) {
      case "text":
        names.add(FUNCTIONAL_TEXT_TYPE_NAME);
        return;
      case "bytes":
        names.add(FUNCTIONAL_BYTES_TYPE_NAME);
        return;
      case "whole-number-f64":
        names.add(FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME);
        return;
      case "lambda":
      case "unary":
      case "numeric-convert":
        visitExpression(expression.kind === "lambda" ? expression.body : expression.value);
        return;
      case "let":
      case "let-rec":
        visitExpression(expression.value);
        visitExpression(expression.body);
        return;
      case "let-rec-group":
        for (const binding of expression.bindings) visitExpression(binding.body);
        visitExpression(expression.body);
        return;
      case "if":
        visitExpression(expression.condition);
        visitExpression(expression.consequent);
        visitExpression(expression.alternate);
        return;
      case "apply":
        visitExpression(expression.callee);
        visitExpression(expression.argument);
        return;
      case "binary":
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      case "text-append":
        names.add(FUNCTIONAL_TEXT_TYPE_NAME);
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      case "bytes-append":
        names.add(FUNCTIONAL_BYTES_TYPE_NAME);
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      case "case":
        visitExpression(expression.value);
        for (const arm of expression.arms) visitExpression(arm.body);
        return;
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "name":
      case "runtime-fault":
        return;
    }
  };
  for (const definition of definitions) visitExpression(definition.body);
  for (const capability of capabilities) {
    for (const field of capability.fields) {
      visit(functionalHostFieldType(field));
      visit(functionalHostFieldRepresentationType(field));
    }
  }
  return names;
}

function expressionFeatureMask(
  expression: FunctionalSurfaceExpression,
  depth = 0,
  traversal: SurfaceExpressionTraversal = {
    activeExpressions: new WeakSet(),
    remainingNodes: FUNCTIONAL_MAXIMUM_EXPRESSION_NODES,
  },
): number {
  if (depth > MAXIMUM_SURFACE_STRUCTURE_DEPTH) {
    throw new RangeError(
      `functional surface expression exceeds depth ${MAXIMUM_SURFACE_STRUCTURE_DEPTH}`,
    );
  }
  if (traversal.remainingNodes === 0) {
    throw new RangeError(
      `functional surface expression exceeds ${FUNCTIONAL_MAXIMUM_EXPRESSION_NODES} nodes`,
    );
  }
  traversal.remainingNodes -= 1;
  if (
    expression === null || typeof expression !== "object" ||
    typeof expression.kind !== "string"
  ) {
    throw new TypeError("functional surface expression must be an object with a kind");
  }
  if (traversal.activeExpressions.has(expression)) {
    throw new TypeError("functional surface expression contains a structural cycle");
  }
  const nested = (child: FunctionalSurfaceExpression): number =>
    expressionFeatureMask(child, depth + 1, traversal);
  traversal.activeExpressions.add(expression);
  try {
    switch (expression.kind) {
      case "name":
        return expression.name === FUNCTIONAL_THUNK_CONSTRUCTOR_NAME
          ? SURFACE_FEATURE_EXPLICIT_THUNK
          : 0;
      case "lambda":
        return nested(expression.body);
      case "let":
      case "let-rec":
        return nested(expression.value) | nested(expression.body);
      case "let-rec-group":
        return expression.bindings.reduce(
          (features, binding) => features | nested(binding.body),
          SURFACE_FEATURE_RECURSIVE_GROUP | nested(expression.body),
        );
      case "if":
        return nested(expression.condition) |
          nested(expression.consequent) |
          nested(expression.alternate);
      case "apply":
        return nested(expression.callee) | nested(expression.argument);
      case "binary":
      case "text-append":
      case "bytes-append":
        return nested(expression.left) | nested(expression.right);
      case "unary":
      case "numeric-convert":
        return nested(expression.value);
      case "case":
        return expression.arms.reduce(
          (features, arm) => features | nested(arm.body),
          nested(expression.value),
        );
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "whole-number-f64":
      case "boolean":
      case "text":
      case "bytes":
      case "runtime-fault":
        return 0;
      default:
        throw new TypeError(
          `functional surface expression has unsupported kind ${
            JSON.stringify((expression as { readonly kind: unknown }).kind)
          }`,
        );
    }
  } finally {
    traversal.activeExpressions.delete(expression);
  }
}

function boundaryTypeDeclaration(
  name: string,
  sourceByteLength: number,
): FunctionalSurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  if (name === FUNCTIONAL_ARRAY_TYPE_NAME || name === FUNCTIONAL_SLICE_TYPE_NAME) {
    return {
      name,
      parameters: ["element"],
      constructors: [{ name: `${name}Value`, fields: [], span }],
      span,
    };
  }
  return { name, parameters: [], constructors: [{ name: `${name}Value`, fields: [], span }], span };
}

function primitiveTypeDeclarations(
  sourceByteLength: number,
  usesExplicitThunk: boolean,
): readonly FunctionalSurfaceTypeDeclaration[] {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return [
    ...(usesExplicitThunk
      ? [{
        name: FUNCTIONAL_THUNK_TYPE_NAME,
        parameters: ["value"],
        constructors: [{
          name: FUNCTIONAL_THUNK_CONSTRUCTOR_NAME,
          fields: [{ name: "value", type: { kind: "parameter", name: "value" } as const, span }],
          span,
        }],
        span,
      }]
      : []),
    {
      name: "$UnitType",
      parameters: [],
      constructors: [{ name: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, fields: [], span }],
      span,
    },
    {
      name: "$TupleType",
      parameters: ["first", "second"],
      constructors: [{
        name: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
        fields: [
          { name: "first", type: { kind: "parameter", name: "first" }, span },
          { name: "second", type: { kind: "parameter", name: "second" }, span },
        ],
        span,
      }],
      span,
    },
  ];
}

class SurfaceExpressionEncoder {
  readonly words: number[] = [];

  constructor(
    private readonly symbols: SurfaceSymbolTable,
    private readonly typeIndices: ReadonlyMap<string, number>,
    private readonly defaultEvaluation: FunctionalEvaluationProfile,
  ) {}

  get nodeCount(): number {
    return this.words.length / FUNCTIONAL_NODE_WORD_LENGTH;
  }

  emitDefinitionBody(
    parameters: readonly string[],
    body: FunctionalSurfaceExpression,
    span: FunctionalSpan | undefined,
  ): number {
    return this.emitParameters(parameters, 0, body, FUNCTIONAL_NO_INDEX, span);
  }

  private emitParameters(
    parameters: readonly string[],
    parameterIndex: number,
    body: FunctionalSurfaceExpression,
    parent: number,
    span: FunctionalSpan | undefined,
  ): number {
    let firstParameter = FUNCTIONAL_NO_INDEX;
    let previousParameter = FUNCTIONAL_NO_INDEX;
    let parameterParent = parent;
    for (let index = parameterIndex; index < parameters.length; index += 1) {
      const parameter = parameters[index];
      if (parameter === undefined) {
        throw new Error(`functional surface definition omitted parameter ${index}`);
      }
      const node = this.reserveNode(
        FunctionalExpressionTag.Lambda,
        this.symbols.intern(parameter),
        parameterParent,
        span,
      );
      if (firstParameter === FUNCTIONAL_NO_INDEX) firstParameter = node;
      if (previousParameter !== FUNCTIONAL_NO_INDEX) {
        this.setChildren(previousParameter, [node]);
      }
      previousParameter = node;
      parameterParent = node;
    }
    const bodyNode = this.emit(body, parameterParent);
    if (previousParameter === FUNCTIONAL_NO_INDEX) return bodyNode;
    this.setChildren(previousParameter, [bodyNode]);
    return firstParameter;
  }

  private emit(expression: FunctionalSurfaceExpression, parent: number): number {
    switch (expression.kind) {
      case "integer":
        return this.emitNode(
          FunctionalExpressionTag.Integer,
          expression.value >>> 0,
          [],
          parent,
          expression.span,
        );
      case "signed-integer-64": {
        if (expression.value < -0x8000000000000000n || expression.value > 0x7fffffffffffffffn) {
          throw new RangeError(
            `functional signed i64 literal must be within [-2^63, 2^63 - 1]; received ${expression.value}`,
          );
        }
        const bits = BigInt.asUintN(64, expression.value);
        const node = this.emitNode(
          FunctionalExpressionTag.SignedInteger64,
          Number(bits & 0xffffffffn),
          [],
          parent,
          expression.span,
        );
        this.words[node * FUNCTIONAL_NODE_WORD_LENGTH + FunctionalNodeWord.Child0] = Number(
          bits >> 32n,
        );
        return node;
      }
      case "float-32":
        return this.emitNode(
          FunctionalExpressionTag.Float32,
          float32Bits(expression.value),
          [],
          parent,
          expression.span,
        );
      case "float-64": {
        const [low, high] = float64Bits(expression.value);
        const node = this.emitNode(
          FunctionalExpressionTag.Float64,
          low,
          [],
          parent,
          expression.span,
        );
        this.words[node * FUNCTIONAL_NODE_WORD_LENGTH + FunctionalNodeWord.Child0] = high;
        return node;
      }
      case "whole-number-f64": {
        if (!Number.isFinite(expression.value) || !Number.isInteger(expression.value)) {
          throw new RangeError(
            `functional whole-number f64 literal must be a finite integer; received ${expression.value}`,
          );
        }
        const typeIndex = this.typeIndices.get(FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME);
        if (typeIndex === undefined) {
          throw new Error(
            `functional surface omitted literal type ${
              JSON.stringify(FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME)
            }`,
          );
        }
        const [low, high] = float64Bits(expression.value);
        const node = this.emitNode(
          FunctionalExpressionTag.WholeNumberF64,
          low,
          [],
          parent,
          expression.span,
        );
        this.words[node * FUNCTIONAL_NODE_WORD_LENGTH + FunctionalNodeWord.Child0] = high;
        this.words[node * FUNCTIONAL_NODE_WORD_LENGTH + FunctionalNodeWord.Child1] = typeIndex;
        return node;
      }
      case "boolean":
        return this.emitNode(
          FunctionalExpressionTag.Boolean,
          expression.value ? 1 : 0,
          [],
          parent,
          expression.span,
        );
      case "text":
      case "bytes": {
        const typeName = expression.kind === "text"
          ? FUNCTIONAL_TEXT_TYPE_NAME
          : FUNCTIONAL_BYTES_TYPE_NAME;
        const typeIndex = this.typeIndices.get(typeName);
        if (typeIndex === undefined) {
          throw new Error(`functional surface omitted literal type ${JSON.stringify(typeName)}`);
        }
        const symbol = expression.kind === "text"
          ? this.symbols.intern(expression.value)
          : this.symbols.intern(functionalBytesLiteralSymbol(expression.value));
        const node = this.emitNode(
          expression.kind === "text" ? FunctionalExpressionTag.Text : FunctionalExpressionTag.Bytes,
          symbol,
          [],
          parent,
          expression.span,
        );
        this.words[node * FUNCTIONAL_NODE_WORD_LENGTH + FunctionalNodeWord.Child0] = typeIndex;
        return node;
      }
      case "runtime-fault":
        return this.emitNode(
          FunctionalExpressionTag.RuntimeFault,
          this.symbols.intern(expression.message),
          [],
          parent,
          expression.span,
        );
      case "name":
        return this.emitNode(
          FunctionalExpressionTag.Name,
          this.symbols.intern(expression.name),
          [],
          parent,
          expression.span,
        );
      case "lambda": {
        const node = this.reserveNode(
          FunctionalExpressionTag.Lambda,
          this.symbols.intern(expression.parameter),
          parent,
          expression.span,
        );
        const body = this.emit(expression.body, node);
        this.setChildren(node, [body]);
        return node;
      }
      case "let": {
        const valueEvaluation = expression.valueEvaluation ?? this.defaultEvaluation;
        requireEvaluationProfile(
          valueEvaluation,
          `functional let ${JSON.stringify(expression.name)}`,
        );
        const node = this.reserveNode(
          valueEvaluation === FunctionalEvaluationProfile.StrictEager
            ? FunctionalExpressionTag.StrictLet
            : FunctionalExpressionTag.Let,
          this.symbols.intern(expression.name),
          parent,
          expression.span,
        );
        const value = this.emit(expression.value, node);
        const body = this.emit(expression.body, node);
        this.setChildren(node, [value, body]);
        return node;
      }
      case "let-rec": {
        const node = this.reserveNode(
          FunctionalExpressionTag.LetRec,
          this.symbols.intern(expression.name),
          parent,
          expression.span,
        );
        const value = this.emit(expression.value, node);
        const body = this.emit(expression.body, node);
        this.setChildren(node, [value, body]);
        return node;
      }
      case "let-rec-group":
        throw new Error("functional recursive group reached the packed surface encoder");
      case "if": {
        const node = this.reserveNode(FunctionalExpressionTag.If, 0, parent, expression.span);
        const condition = this.emit(expression.condition, node);
        const consequent = this.emit(expression.consequent, node);
        const alternate = this.emit(expression.alternate, node);
        this.setChildren(node, [condition, consequent, alternate]);
        return node;
      }
      case "apply": {
        const argumentEvaluation = expression.argumentEvaluation ?? this.defaultEvaluation;
        requireEvaluationProfile(argumentEvaluation, "functional application argument");
        const node = this.reserveNode(
          argumentEvaluation === FunctionalEvaluationProfile.StrictEager
            ? FunctionalExpressionTag.StrictApply
            : FunctionalExpressionTag.Apply,
          0,
          parent,
          expression.span,
        );
        const callee = this.emit(expression.callee, node);
        const argument = this.emit(expression.argument, node);
        this.setChildren(node, [callee, argument]);
        return node;
      }
      case "unary": {
        const node = this.reserveNode(
          FunctionalExpressionTag.Unary,
          expression.operator,
          parent,
          expression.span,
        );
        const value = this.emit(expression.value, node);
        this.setChildren(node, [value]);
        if (expression.operator === FunctionalUnaryOperator.NegateWholeNumberF64) {
          this.words[node * FUNCTIONAL_NODE_WORD_LENGTH + FunctionalNodeWord.Child1] = this
            .requiredTypeIndex(FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME);
        }
        return node;
      }
      case "binary": {
        const node = this.reserveNode(
          FunctionalExpressionTag.Binary,
          expression.operator,
          parent,
          expression.span,
        );
        const left = this.emit(expression.left, node);
        const right = this.emit(expression.right, node);
        this.setChildren(node, [left, right]);
        if (
          expression.operator >= FunctionalBinaryOperator.EqualWholeNumberF64 &&
          expression.operator <= FunctionalBinaryOperator.RemainderWholeNumberF64
        ) {
          this.words[node * FUNCTIONAL_NODE_WORD_LENGTH + FunctionalNodeWord.Child2] = this
            .requiredTypeIndex(FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME);
        }
        return node;
      }
      case "text-append":
      case "bytes-append": {
        const node = this.reserveNode(
          FunctionalExpressionTag.BufferAppend,
          0,
          parent,
          expression.span,
        );
        const left = this.emit(expression.left, node);
        const right = this.emit(expression.right, node);
        this.setChildren(node, [left, right]);
        this.words[node * FUNCTIONAL_NODE_WORD_LENGTH + FunctionalNodeWord.Child2] = this
          .requiredTypeIndex(
            expression.kind === "text-append"
              ? FUNCTIONAL_TEXT_TYPE_NAME
              : FUNCTIONAL_BYTES_TYPE_NAME,
          );
        return node;
      }
      case "numeric-convert": {
        const node = this.reserveNode(
          FunctionalExpressionTag.NumericConvert,
          expression.conversion,
          parent,
          expression.span,
        );
        const value = this.emit(expression.value, node);
        this.setChildren(node, [value]);
        return node;
      }
      case "case": {
        const node = this.reserveNode(FunctionalExpressionTag.Case, 0, parent, expression.span);
        const value = this.emit(expression.value, node);
        const firstArm = this.emitCaseArms(expression.arms, 0, node);
        this.setChildren(node, [value, firstArm]);
        return node;
      }
    }
  }

  private emitCaseArms(
    arms: readonly FunctionalSurfaceCaseArm[],
    armIndex: number,
    parent: number,
  ): number {
    let firstArm = FUNCTIONAL_NO_INDEX;
    let previousArm = FUNCTIONAL_NO_INDEX;
    let previousBody = FUNCTIONAL_NO_INDEX;
    let armParent = parent;
    for (let index = armIndex; index < arms.length; index += 1) {
      const arm = arms[index];
      if (arm === undefined) throw new Error(`functional surface case omitted arm ${index}`);
      const node = this.reserveNode(
        FunctionalExpressionTag.CaseArm,
        this.symbols.intern(arm.constructor),
        armParent,
        arm.span,
      );
      if (firstArm === FUNCTIONAL_NO_INDEX) firstArm = node;
      if (previousArm !== FUNCTIONAL_NO_INDEX) {
        this.setChildren(previousArm, [previousBody, node]);
      }
      previousArm = node;
      previousBody = this.emitPatternBindings(arm.binders, arm.body, node);
      armParent = node;
    }
    if (previousArm !== FUNCTIONAL_NO_INDEX) {
      this.setChildren(previousArm, [previousBody, FUNCTIONAL_NO_INDEX]);
    }
    return firstArm;
  }

  private emitPatternBindings(
    binders: readonly string[],
    body: FunctionalSurfaceExpression,
    parent: number,
  ): number {
    let bindingParent = parent;
    let firstBinding = FUNCTIONAL_NO_INDEX;
    for (let binderIndex = binders.length - 1; binderIndex >= 0; binderIndex--) {
      const binder = binders[binderIndex];
      if (binder === undefined) {
        throw new Error(`functional surface case arm omitted binder ${binderIndex}`);
      }
      const binding = this.reserveNode(
        FunctionalExpressionTag.PatternBind,
        this.symbols.intern(binder),
        bindingParent,
        parentSpan(this.words, parent),
      );
      if (firstBinding === FUNCTIONAL_NO_INDEX) firstBinding = binding;
      else this.setChildren(bindingParent, [binding]);
      bindingParent = binding;
    }
    const bodyNode = this.emit(body, bindingParent);
    if (firstBinding === FUNCTIONAL_NO_INDEX) return bodyNode;
    this.setChildren(bindingParent, [bodyNode]);
    return firstBinding;
  }

  private emitNode(
    tag: number,
    payload: number,
    children: readonly number[],
    parent: number,
    span: FunctionalSpan | undefined,
  ): number {
    const node = this.reserveNode(tag, payload, parent, span);
    this.setChildren(node, children);
    return node;
  }

  private requiredTypeIndex(name: string): number {
    const typeIndex = this.typeIndices.get(name);
    if (typeIndex === undefined) {
      throw new Error(`functional surface omitted expression type ${JSON.stringify(name)}`);
    }
    return typeIndex;
  }

  private reserveNode(
    tag: number,
    payload: number,
    parent: number,
    span?: FunctionalSpan,
  ): number {
    const node = this.nodeCount;
    if (node >= FUNCTIONAL_MAXIMUM_EXPRESSION_NODES) {
      throw new RangeError(
        `functional surface module exceeds ${FUNCTIONAL_MAXIMUM_EXPRESSION_NODES} expression nodes`,
      );
    }
    this.words.push(
      tag,
      span?.startByte ?? 0,
      span?.endByte ?? 0,
      payload,
      FUNCTIONAL_NO_INDEX,
      FUNCTIONAL_NO_INDEX,
      FUNCTIONAL_NO_INDEX,
      parent,
    );
    return node;
  }

  private setChildren(node: number, children: readonly number[]): void {
    if (children.length > 3) {
      throw new Error(`functional surface node ${node} has ${children.length} children`);
    }
    const offset = node * FUNCTIONAL_NODE_WORD_LENGTH + FunctionalNodeWord.Child0;
    for (const [childIndex, child] of children.entries()) {
      this.words[offset + childIndex] = child;
    }
  }
}

function requireEvaluationProfile(
  profile: FunctionalEvaluationProfile,
  location: string,
): void {
  if (
    profile === FunctionalEvaluationProfile.LazyCallByNeed ||
    profile === FunctionalEvaluationProfile.StrictEager
  ) return;
  throw new Error(
    `${location} has unsupported evaluation profile ${JSON.stringify(profile)}`,
  );
}

class SurfaceSymbolTable {
  readonly #ids = new Map<string, number>();
  readonly #names: string[] = [];

  get names(): readonly string[] {
    return this.#names;
  }

  intern(name: string): number {
    const existing = this.#ids.get(name);
    if (existing !== undefined) return existing;
    const symbol = this.#names.length;
    this.#ids.set(name, symbol);
    this.#names.push(name);
    return symbol;
  }

  id(name: string): number {
    const symbol = this.#ids.get(name);
    if (symbol === undefined) {
      throw new Error(`functional surface omitted symbol ${JSON.stringify(name)}`);
    }
    return symbol;
  }
}

function sourceType(
  schema: FunctionalTypeSchema,
  span: FunctionalSpan | undefined,
): FunctionalSourceType {
  const sourceSpan = span ?? { startByte: 0, endByte: 0 };
  switch (schema.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
    case "parameter":
      return { ...schema, ...sourceSpan };
    case "tuple":
      return {
        ...schema,
        values: [sourceType(schema.values[0], span), sourceType(schema.values[1], span)],
        ...sourceSpan,
      };
    case "named":
      return {
        ...schema,
        arguments: schema.arguments.map((argument) => sourceType(argument, span)),
        ...sourceSpan,
      };
    case "function":
      return {
        ...schema,
        parameter: sourceType(schema.parameter, span),
        result: sourceType(schema.result, span),
        ...sourceSpan,
      };
    case "forall":
      return {
        ...schema,
        parameters: [...schema.parameters],
        body: sourceType(schema.body, span),
        ...sourceSpan,
      };
  }
}

function parentSpan(words: readonly number[], parent: number): FunctionalSpan | undefined {
  if (parent === FUNCTIONAL_NO_INDEX) return undefined;
  const offset = parent * FUNCTIONAL_NODE_WORD_LENGTH;
  const startByte = words[offset + FunctionalNodeWord.StartByte];
  const endByte = words[offset + FunctionalNodeWord.EndByte];
  if (startByte === undefined || endByte === undefined) return undefined;
  return { startByte, endByte };
}

export const surface: Readonly<{
  integer(value: number): FunctionalSurfaceExpression;
  signedInteger64(value: bigint): FunctionalSurfaceExpression;
  float32(value: number): FunctionalSurfaceExpression;
  float64(value: number): FunctionalSurfaceExpression;
  wholeNumberF64(value: number): FunctionalSurfaceExpression;
  boolean(value: boolean): FunctionalSurfaceExpression;
  text(value: string): FunctionalSurfaceExpression;
  bytes(value: Uint8Array): FunctionalSurfaceExpression;
  runtimeFault(message: string): FunctionalSurfaceExpression;
  name(name: string): FunctionalSurfaceExpression;
  lambda(parameter: string, body: FunctionalSurfaceExpression): FunctionalSurfaceExpression;
  delay(value: FunctionalSurfaceExpression): FunctionalSurfaceExpression;
  force(value: FunctionalSurfaceExpression): FunctionalSurfaceExpression;
  apply(
    callee: FunctionalSurfaceExpression,
    ...arguments_: readonly FunctionalSurfaceExpression[]
  ): FunctionalSurfaceExpression;
  binary(
    operator: FunctionalBinaryOperator,
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  unary(
    operator: FunctionalUnaryOperator,
    value: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  convert(
    conversion: FunctionalNumericConversion,
    value: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  equal(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
  structuralEqual(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression;
}> = {
  integer(value: number): FunctionalSurfaceExpression {
    return { kind: "integer", value };
  },
  signedInteger64(value: bigint): FunctionalSurfaceExpression {
    return { kind: "signed-integer-64", value };
  },
  float32(value: number): FunctionalSurfaceExpression {
    return { kind: "float-32", value };
  },
  float64(value: number): FunctionalSurfaceExpression {
    return { kind: "float-64", value };
  },
  wholeNumberF64(value: number): FunctionalSurfaceExpression {
    return { kind: "whole-number-f64", value };
  },
  boolean(value: boolean): FunctionalSurfaceExpression {
    return { kind: "boolean", value };
  },
  name(name: string): FunctionalSurfaceExpression {
    return { kind: "name", name };
  },
  lambda(
    parameter: string,
    body: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    return { kind: "lambda", parameter, body };
  },
  delay(value: FunctionalSurfaceExpression): FunctionalSurfaceExpression {
    return {
      kind: "apply",
      callee: { kind: "name", name: FUNCTIONAL_THUNK_CONSTRUCTOR_NAME },
      argument: value,
      argumentEvaluation: FunctionalEvaluationProfile.LazyCallByNeed,
    };
  },
  force(value: FunctionalSurfaceExpression): FunctionalSurfaceExpression {
    const valueName = "$forcedThunkValue";
    return {
      kind: "case",
      value,
      arms: [{
        constructor: FUNCTIONAL_THUNK_CONSTRUCTOR_NAME,
        binders: [valueName],
        body: { kind: "name", name: valueName },
      }],
    };
  },
  apply(
    callee: FunctionalSurfaceExpression,
    ...arguments_: readonly FunctionalSurfaceExpression[]
  ): FunctionalSurfaceExpression {
    let expression = callee;
    for (const argument of arguments_) expression = { kind: "apply", callee: expression, argument };
    return expression;
  },
  binary(
    operator: FunctionalBinaryOperator,
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    return { kind: "binary", operator, left, right };
  },
  unary(
    operator: FunctionalUnaryOperator,
    value: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    return { kind: "unary", operator, value };
  },
  convert(
    conversion: FunctionalNumericConversion,
    value: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    return { kind: "numeric-convert", conversion, value };
  },
  equal(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    return { kind: "binary", operator: FunctionalBinaryOperator.Equal, left, right };
  },
  structuralEqual(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    return {
      kind: "binary",
      operator: FunctionalBinaryOperator.StructuralEqual,
      left,
      right,
    };
  },
  text(value: string): FunctionalSurfaceExpression {
    return { kind: "text", value };
  },
  bytes(value: Uint8Array): FunctionalSurfaceExpression {
    return { kind: "bytes", value: value.slice() };
  },
  runtimeFault(message: string): FunctionalSurfaceExpression {
    return { kind: "runtime-fault", message };
  },
};

function float32Bits(value: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function float64Bits(value: number): readonly [number, number] {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, true);
  return [view.getUint32(0, true), view.getUint32(4, true)];
}
