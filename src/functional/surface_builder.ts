import {
  ARGUMENT_WORD_LENGTH,
  ArgumentWord,
  BinaryOperator,
  BranchLikelihood,
  CASE_ALTERNATIVE_WORD_LENGTH,
  CaseAlternativeWord,
  CONSTRUCTOR_WORD_LENGTH,
  CORE_V1_PRIMITIVE_CAPABILITIES,
  type EncodedModule,
  EvaluationMode,
  ExpressionTag,
  MAXIMUM_EXPRESSION_NODES,
  MODULE_ABI_VERSION,
  NO_INDEX,
  NODE_WORD_LENGTH,
  NodeWord,
  type NumericConversion,
  PAIR_CONSTRUCTOR_NAME,
  RuntimeFaultCategory,
  type SourceType,
  type Span,
  THUNK_CONSTRUCTOR_NAME,
  THUNK_TYPE_NAME,
  TypecheckingProfile,
  type TypeSchema,
  UnaryOperator,
  UNIT_CONSTRUCTOR_NAME,
} from "./abi.ts";
import {
  binaryPrimop,
  BufferAppendPrimop,
  numericConversionPrimop,
  StoreEmptyPrimop,
  StoreGrowPrimop,
  StoreLengthPrimop,
  StoreNewPrimop,
  StoreReadPrimop,
  StoreWritePrimop,
  unaryPrimop,
} from "../semantic/primops.ts";
import {
  ARRAY_TYPE_NAME,
  BYTES_TYPE_NAME,
  ERASED_TYPE_NAME,
  hostFieldRepresentationType,
  hostFieldType,
  INIT_CONSTRUCTOR_NAME,
  INIT_TYPE_NAME,
  normalizeHostCapabilities,
  RESOURCE_TYPE_PREFIX,
  SLICE_TYPE_NAME,
  type SurfaceModuleOptions,
  TEXT_TYPE_NAME,
  WHOLE_NUMBER_F64_TYPE_NAME,
} from "./host_contract.ts";
import { elaborateCaseDefaults } from "./case_defaults.ts";
import { type EffectSet, effectSet, effectSetFrom } from "./effect_set.ts";
import { elaborateRecursiveGroups } from "./recursive_groups.ts";
import { functionalBytesLiteralSymbol } from "./static_literals.ts";
import type {
  SurfaceCaseArm,
  SurfaceCaseDefault,
  SurfaceDefinition,
  SurfaceExpression,
  SurfaceTypeDeclaration,
} from "./surface_contract.ts";
import { STORE_TYPE_NAME } from "./store_contract.ts";
import {
  createStructuralRecordSurface,
  type StructuralRecordSurface,
} from "./structural_record.ts";

export type {
  SurfaceCaseArm,
  SurfaceCaseDefault,
  SurfaceDefinition,
  SurfaceExpression,
  SurfaceRecursiveBinding,
  SurfaceRecursiveGroup,
  SurfaceTypeDeclaration,
} from "./surface_contract.ts";

const SURFACE_FEATURE_RECURSIVE_GROUP = 1 << 0;
const SURFACE_FEATURE_EXPLICIT_THUNK = 1 << 1;
const SURFACE_FEATURE_STORE = 1 << 2;
const SURFACE_FEATURE_CASE_DEFAULT = 1 << 3;
const MAXIMUM_SURFACE_EXPRESSION_DEPTH = 1_024;
const MAXIMUM_SURFACE_TYPE_DEPTH = 512;
const MAXIMUM_SURFACE_TYPE_NODES = 4_096;

interface SurfaceTypeTraversal {
  readonly activeTypes: WeakSet<object>;
  remainingNodes: number;
}

export interface SurfaceEffectOperation {
  readonly name: string;
  readonly parameter: {
    readonly name: string;
    readonly type: TypeSchema;
  };
  readonly result: TypeSchema;
  readonly effects: EffectSet;
  readonly body: SurfaceExpression;
  readonly span?: Span;
}

/**
 * Declares an effect operation as ordinary callable evidence. Effect summaries follow the
 * operation through higher-order calls.
 */
export function defineEffectOperation(
  operation: SurfaceEffectOperation,
): SurfaceDefinition {
  return {
    name: operation.name,
    parameters: [operation.parameter.name],
    annotation: {
      kind: "function",
      parameter: operation.parameter.type,
      result: operation.result,
    },
    effects: effectSetFrom(operation.effects),
    body: operation.body,
    ...(operation.span === undefined ? {} : { span: operation.span }),
  };
}

export function thunkType(value: TypeSchema): TypeSchema {
  return {
    kind: "named",
    name: THUNK_TYPE_NAME,
    arguments: [value],
  };
}

export function buildSurfaceModule(
  definitions: readonly SurfaceDefinition[],
  typeDeclarations: readonly SurfaceTypeDeclaration[],
  entryName: string,
  sourceByteLength: number,
  options: SurfaceModuleOptions = {},
): EncodedModule {
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
  const withCaseDefaults = surfaceFeatures & SURFACE_FEATURE_CASE_DEFAULT
    ? elaborateCaseDefaults(definitions, typeDeclarations)
    : definitions;
  const elaboratedDefinitions = surfaceFeatures & SURFACE_FEATURE_RECURSIVE_GROUP
    ? elaborateRecursiveGroups(withCaseDefaults)
    : withCaseDefaults;
  if ((surfaceFeatures & SURFACE_FEATURE_RECURSIVE_GROUP) !== 0) {
    for (const definition of elaboratedDefinitions) expressionFeatureMask(definition.body);
  }
  const hostCapabilities = normalizeHostCapabilities(options.hostCapabilities);
  const declaredDefinitionEffects = Object.freeze(
    elaboratedDefinitions.map((definition, definitionIndex) => {
      if (definition.effects === undefined) return effectSet();
      if (!(definition.effects instanceof Set)) {
        throw new TypeError(
          `functional definition ${definitionIndex} effects must be a ReadonlySet; received ${
            JSON.stringify(definition.effects)
          }`,
        );
      }
      return effectSetFrom(definition.effects);
    }),
  );
  const hostDefinitions = normalizeHostDefinitions(
    elaboratedDefinitions,
    declaredDefinitionEffects,
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
      declaredName === THUNK_TYPE_NAME ||
      declaredName === INIT_TYPE_NAME || declaredName === TEXT_TYPE_NAME ||
      declaredName === BYTES_TYPE_NAME || declaredName === ERASED_TYPE_NAME ||
      declaredName === ARRAY_TYPE_NAME ||
      declaredName === STORE_TYPE_NAME ||
      declaredName === WHOLE_NUMBER_F64_TYPE_NAME ||
      declaredName === SLICE_TYPE_NAME ||
      declaredName.startsWith(RESOURCE_TYPE_PREFIX)
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
  const usesStore = (surfaceFeatures & SURFACE_FEATURE_STORE) !== 0;
  const encodedTypeDeclarations = [
    ...typeDeclarations,
    ...[...boundaryTypeNames].sort().map((name) => boundaryTypeDeclaration(name, sourceByteLength)),
    ...(hostCapabilities.length === 0
      ? []
      : [hostInitTypeDeclaration(hostCapabilities, sourceByteLength)]),
    ...primitiveTypeDeclarations(sourceByteLength, usesExplicitThunk, usesStore),
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
  const constructorIndices = new Map<string, number>();
  const callableArities = new Map<string, number>();
  let nextConstructorIndex = 0;
  for (const declaration of encodedTypeDeclarations) {
    for (const constructor of declaration.constructors) {
      constructorIndices.set(constructor.name, nextConstructorIndex);
      if (constructor.fields.length > 0) {
        callableArities.set(constructor.name, constructor.fields.length);
      }
      nextConstructorIndex += 1;
    }
  }
  for (const definition of elaboratedDefinitions) {
    const arity = definition.parameters.length > 0
      ? definition.parameters.length
      : definition.body.kind === "lambda"
      ? definition.body.parameters.length
      : undefined;
    if (arity !== undefined) callableArities.set(definition.name, arity);
  }
  const encoder = new SurfaceExpressionEncoder(
    symbols,
    typeIndices,
    constructorIndices,
    callableArities,
  );
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
    const firstConstructor = constructorWords.length / CONSTRUCTOR_WORD_LENGTH;
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
    abiVersion: MODULE_ABI_VERSION,
    sourceByteLength,
    typecheckingProfile: usesHigherRankTypes
      ? TypecheckingProfile.PredicativeRankNIndexed
      : TypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: CORE_V1_PRIMITIVE_CAPABILITIES,
    hostCapabilities,
    hostDefinitions,
    declaredDefinitionEffects,
    wasmExports,
    nodeWords: Uint32Array.from(encoder.words),
    parameterWords: Uint32Array.from(encoder.parameterWords),
    argumentWords: Uint32Array.from(encoder.argumentWords),
    caseAlternativeWords: Uint32Array.from(encoder.caseAlternativeWords),
    caseBinderWords: Uint32Array.from(encoder.caseBinderWords),
    definitionWords: Uint32Array.from(definitionWords),
    typeWords: Uint32Array.from(typeWords),
    constructorWords: Uint32Array.from(constructorWords),
    nodeCount: encoder.nodeCount,
    argumentCount: encoder.argumentWords.length / ARGUMENT_WORD_LENGTH,
    caseAlternativeCount: encoder.caseAlternativeWords.length /
      CASE_ALTERNATIVE_WORD_LENGTH,
    definitionCount: elaboratedDefinitions.length,
    typeCount: encodedTypeDeclarations.length,
    constructorCount: constructorWords.length / CONSTRUCTOR_WORD_LENGTH,
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
  schema: TypeSchema,
  location: string,
  depth = 0,
  traversal: SurfaceTypeTraversal = {
    activeTypes: new WeakSet(),
    remainingNodes: MAXIMUM_SURFACE_TYPE_NODES,
  },
): void {
  if (depth > MAXIMUM_SURFACE_TYPE_DEPTH) {
    throw new RangeError(
      `functional surface ${location} exceeds type depth ${MAXIMUM_SURFACE_TYPE_DEPTH}`,
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
  definitions: readonly SurfaceDefinition[],
  declaredDefinitionEffects: readonly EffectSet[],
  capabilities: ReturnType<typeof normalizeHostCapabilities>,
  bindings: SurfaceModuleOptions["hostDefinitions"],
): NonNullable<SurfaceModuleOptions["hostDefinitions"]> {
  if (bindings === undefined) return Object.freeze([]);
  if (!Array.isArray(bindings)) {
    throw new TypeError("functional host definition bindings must be an array");
  }
  const definitionsByName = new Map(definitions.map((definition, definitionIndex) => [
    definition.name,
    { definition, effects: declaredDefinitionEffects[definitionIndex]! },
  ]));
  const boundDefinitions = new Set<string>();
  return Object.freeze(bindings.map((binding, index) => {
    if (binding === null || typeof binding !== "object") {
      throw new TypeError(
        `functional host definition binding ${index} must be an object; received ${
          JSON.stringify(binding)
        }`,
      );
    }
    const resolvedDefinition = definitionsByName.get(binding.definition);
    if (resolvedDefinition === undefined) {
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
    const expectedType: TypeSchema = field.kind === "value"
      ? field.type
      : { kind: "function", parameter: field.parameter, result: field.result };
    if (
      resolvedDefinition.definition.annotation === null ||
      JSON.stringify(resolvedDefinition.definition.annotation) !== JSON.stringify(expectedType)
    ) {
      throw new Error(
        `functional host definition ${JSON.stringify(binding.definition)} annotation ${
          JSON.stringify(resolvedDefinition.definition.annotation)
        } does not match field ${JSON.stringify(`${binding.capability}.${binding.field}`)} type ${
          JSON.stringify(expectedType)
        }`,
      );
    }
    if (
      resolvedDefinition.effects.size !== 0 &&
      (
        field.kind !== "operation" ||
        resolvedDefinition.effects.size !== field.effects.size ||
        ![...resolvedDefinition.effects].every((effect) => field.effects.has(effect))
      )
    ) {
      throw new Error(
        `functional host definition ${JSON.stringify(binding.definition)} declares effects ${
          JSON.stringify([...resolvedDefinition.effects])
        }; field ${JSON.stringify(`${binding.capability}.${binding.field}`)} declares ${
          JSON.stringify(field.kind === "operation" ? [...field.effects] : [])
        }`,
      );
    }
    boundDefinitions.add(binding.definition);
    return Object.freeze({ ...binding });
  }));
}

function normalizeWasmExports(
  definitions: readonly SurfaceDefinition[],
  declarations: SurfaceModuleOptions["wasmExports"],
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

function schemaContainsForall(schema: TypeSchema): boolean {
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
  capabilities: ReturnType<typeof normalizeHostCapabilities>,
  sourceByteLength: number,
): SurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return {
    name: INIT_TYPE_NAME,
    parameters: [],
    span,
    constructors: [{
      name: INIT_CONSTRUCTOR_NAME,
      span,
      fields: capabilities.flatMap((capability) =>
        capability.fields.map((field) => ({
          name: `${capability.name}.${field.name}`,
          type: hostFieldType(field),
          span,
        }))
      ),
    }],
  };
}

function collectBoundaryTypeNames(
  definitions: readonly SurfaceDefinition[],
  typeDeclarations: readonly SurfaceTypeDeclaration[],
  capabilities: ReturnType<typeof normalizeHostCapabilities>,
): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (schema: TypeSchema): void => {
    if (schema.kind === "named") {
      if (
        schema.name === TEXT_TYPE_NAME || schema.name === BYTES_TYPE_NAME ||
        schema.name === ERASED_TYPE_NAME ||
        schema.name === WHOLE_NUMBER_F64_TYPE_NAME ||
        schema.name === ARRAY_TYPE_NAME || schema.name === SLICE_TYPE_NAME ||
        schema.name.startsWith(RESOURCE_TYPE_PREFIX)
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
  const visitExpression = (expression: SurfaceExpression): void => {
    switch (expression.kind) {
      case "text":
        names.add(TEXT_TYPE_NAME);
        return;
      case "bytes":
        names.add(BYTES_TYPE_NAME);
        return;
      case "whole-number-f64":
        names.add(WHOLE_NUMBER_F64_TYPE_NAME);
        return;
      case "lambda":
      case "unary":
      case "numeric-convert":
        visitExpression(expression.kind === "lambda" ? expression.body : expression.value);
        return;
      case "let":
      case "sequence":
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
        for (const argument of expression.arguments) visitExpression(argument);
        return;
      case "binary":
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      case "text-append":
        names.add(TEXT_TYPE_NAME);
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      case "bytes-append":
        names.add(BYTES_TYPE_NAME);
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      case "store-empty":
        return;
      case "case":
        visitExpression(expression.value);
        for (const arm of expression.arms) visitExpression(arm.body);
        if (expression.otherwise !== undefined) visitExpression(expression.otherwise.body);
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
      visit(hostFieldType(field));
      visit(hostFieldRepresentationType(field));
    }
  }
  return names;
}

function expressionFeatureMask(expression: SurfaceExpression): number {
  const activeExpressions = new WeakSet<object>();
  const pending: {
    readonly expression: SurfaceExpression;
    readonly depth: number;
    readonly exiting: boolean;
  }[] = [{ expression, depth: 0, exiting: false }];
  let remainingNodes = MAXIMUM_EXPRESSION_NODES;
  let features = 0;
  while (pending.length !== 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (current.exiting) {
      activeExpressions.delete(current.expression);
      continue;
    }
    if (remainingNodes === 0) {
      throw new RangeError(
        `functional surface expression exceeds ${MAXIMUM_EXPRESSION_NODES} nodes`,
      );
    }
    if (current.depth > MAXIMUM_SURFACE_EXPRESSION_DEPTH) {
      throw new RangeError(
        `functional surface expression exceeds depth ${MAXIMUM_SURFACE_EXPRESSION_DEPTH}`,
      );
    }
    remainingNodes -= 1;
    const nested = current.expression;
    if (
      nested === null || typeof nested !== "object" ||
      typeof nested.kind !== "string"
    ) {
      throw new TypeError("functional surface expression must be an object with a kind");
    }
    if (activeExpressions.has(nested)) {
      throw new TypeError("functional surface expression contains a structural cycle");
    }
    activeExpressions.add(nested);
    pending.push({ expression: nested, depth: current.depth, exiting: true });
    const visit = (child: SurfaceExpression): void => {
      pending.push({ expression: child, depth: current.depth + 1, exiting: false });
    };
    switch (nested.kind) {
      case "name":
        if (nested.name === THUNK_CONSTRUCTOR_NAME) {
          features |= SURFACE_FEATURE_EXPLICIT_THUNK;
        }
        break;
      case "lambda":
        visit(nested.body);
        break;
      case "let":
      case "sequence":
      case "let-rec":
        visit(nested.body);
        visit(nested.value);
        break;
      case "let-rec-group":
        features |= SURFACE_FEATURE_RECURSIVE_GROUP;
        visit(nested.body);
        for (const binding of nested.bindings) visit(binding.body);
        break;
      case "if":
        if (
          nested.likely !== undefined && nested.likely !== "consequent" &&
          nested.likely !== "alternate"
        ) {
          throw new TypeError(
            `functional if branch likelihood must be consequent or alternate; received ${
              JSON.stringify(nested.likely)
            }`,
          );
        }
        visit(nested.alternate);
        visit(nested.consequent);
        visit(nested.condition);
        break;
      case "apply":
        for (const argument of nested.arguments) visit(argument);
        visit(nested.callee);
        break;
      case "binary":
      case "text-append":
      case "bytes-append":
        visit(nested.right);
        visit(nested.left);
        break;
      case "store-new":
        features |= SURFACE_FEATURE_STORE;
        visit(nested.initial);
        visit(nested.length);
        break;
      case "store-empty":
        features |= SURFACE_FEATURE_STORE;
        break;
      case "store-length":
        features |= SURFACE_FEATURE_STORE;
        visit(nested.store);
        break;
      case "store-read":
        features |= SURFACE_FEATURE_STORE;
        visit(nested.index);
        visit(nested.store);
        break;
      case "store-write":
        features |= SURFACE_FEATURE_STORE;
        visit(nested.value);
        visit(nested.index);
        visit(nested.store);
        break;
      case "store-grow":
        features |= SURFACE_FEATURE_STORE;
        visit(nested.initial);
        visit(nested.length);
        visit(nested.store);
        break;
      case "unary":
      case "numeric-convert":
        visit(nested.value);
        break;
      case "case":
        for (const arm of nested.arms) visit(arm.body);
        if (nested.otherwise !== undefined) {
          features |= SURFACE_FEATURE_CASE_DEFAULT;
          visit(nested.otherwise.body);
        }
        visit(nested.value);
        break;
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "whole-number-f64":
      case "boolean":
      case "text":
      case "bytes":
      case "runtime-fault":
        break;
      default:
        throw new TypeError(
          `functional surface expression has unsupported kind ${
            JSON.stringify((nested as { readonly kind: unknown }).kind)
          }`,
        );
    }
  }
  return features;
}

function boundaryTypeDeclaration(
  name: string,
  sourceByteLength: number,
): SurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  if (name === ARRAY_TYPE_NAME || name === SLICE_TYPE_NAME) {
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
  usesStore: boolean,
): readonly SurfaceTypeDeclaration[] {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return [
    ...(usesExplicitThunk
      ? [{
        name: THUNK_TYPE_NAME,
        parameters: ["value"],
        constructors: [{
          name: THUNK_CONSTRUCTOR_NAME,
          fields: [{ name: "value", type: { kind: "parameter", name: "value" } as const, span }],
          span,
        }],
        span,
      }]
      : []),
    ...(usesStore
      ? [{
        name: STORE_TYPE_NAME,
        parameters: ["element"],
        constructors: [],
        span,
      }]
      : []),
    {
      name: "$UnitType",
      parameters: [],
      constructors: [{ name: UNIT_CONSTRUCTOR_NAME, fields: [], span }],
      span,
    },
    {
      name: "$TupleType",
      parameters: ["first", "second"],
      constructors: [{
        name: PAIR_CONSTRUCTOR_NAME,
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
  readonly parameterWords: number[] = [];
  readonly argumentWords: number[] = [];
  readonly caseAlternativeWords: number[] = [];
  readonly caseBinderWords: number[] = [];
  private etaExpansion = 0;

  constructor(
    private readonly symbols: SurfaceSymbolTable,
    private readonly typeIndices: ReadonlyMap<string, number>,
    private readonly constructorIndices: ReadonlyMap<string, number>,
    private readonly callableArities: ReadonlyMap<string, number>,
  ) {}

  get nodeCount(): number {
    return this.words.length / NODE_WORD_LENGTH;
  }

  emitDefinitionBody(
    parameters: readonly string[],
    body: SurfaceExpression,
    span: Span | undefined,
  ): number {
    if (parameters.length === 0) return this.emit(body, NO_INDEX);
    return this.emit(
      { kind: "lambda", parameters, body, ...(span === undefined ? {} : { span }) },
      NO_INDEX,
    );
  }

  private emit(expression: SurfaceExpression, parent: number): number {
    switch (expression.kind) {
      case "integer":
        return this.emitNode(
          ExpressionTag.Integer,
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
          ExpressionTag.SignedInteger64,
          Number(bits & 0xffffffffn),
          [],
          parent,
          expression.span,
        );
        this.words[node * NODE_WORD_LENGTH + NodeWord.Child0] = Number(
          bits >> 32n,
        );
        return node;
      }
      case "float-32":
        return this.emitNode(
          ExpressionTag.Float32,
          float32Bits(expression.value),
          [],
          parent,
          expression.span,
        );
      case "float-64": {
        const [low, high] = float64Bits(expression.value);
        const node = this.emitNode(
          ExpressionTag.Float64,
          low,
          [],
          parent,
          expression.span,
        );
        this.words[node * NODE_WORD_LENGTH + NodeWord.Child0] = high;
        return node;
      }
      case "whole-number-f64": {
        if (!Number.isFinite(expression.value) || !Number.isInteger(expression.value)) {
          throw new RangeError(
            `functional whole-number f64 literal must be a finite integer; received ${expression.value}`,
          );
        }
        const typeIndex = this.typeIndices.get(WHOLE_NUMBER_F64_TYPE_NAME);
        if (typeIndex === undefined) {
          throw new Error(
            `functional surface omitted literal type ${JSON.stringify(WHOLE_NUMBER_F64_TYPE_NAME)}`,
          );
        }
        const [low, high] = float64Bits(expression.value);
        const node = this.emitNode(
          ExpressionTag.WholeNumberF64,
          low,
          [],
          parent,
          expression.span,
        );
        this.words[node * NODE_WORD_LENGTH + NodeWord.Child0] = high;
        this.words[node * NODE_WORD_LENGTH + NodeWord.Child1] = typeIndex;
        return node;
      }
      case "boolean":
        return this.emitNode(
          ExpressionTag.Boolean,
          expression.value ? 1 : 0,
          [],
          parent,
          expression.span,
        );
      case "text":
      case "bytes": {
        const typeName = expression.kind === "text" ? TEXT_TYPE_NAME : BYTES_TYPE_NAME;
        const typeIndex = this.typeIndices.get(typeName);
        if (typeIndex === undefined) {
          throw new Error(`functional surface omitted literal type ${JSON.stringify(typeName)}`);
        }
        const symbol = expression.kind === "text"
          ? this.symbols.intern(expression.value)
          : this.symbols.intern(functionalBytesLiteralSymbol(expression.value));
        const node = this.emitNode(
          expression.kind === "text" ? ExpressionTag.Text : ExpressionTag.Bytes,
          symbol,
          [],
          parent,
          expression.span,
        );
        this.words[node * NODE_WORD_LENGTH + NodeWord.Child0] = typeIndex;
        return node;
      }
      case "runtime-fault": {
        const node = this.emitNode(
          ExpressionTag.RuntimeFault,
          this.symbols.intern(expression.message),
          [],
          parent,
          expression.span,
        );
        this.words[node * NODE_WORD_LENGTH + NodeWord.Child0] =
          expression.category === "unreachable"
            ? RuntimeFaultCategory.Unreachable
            : RuntimeFaultCategory.Explicit;
        return node;
      }
      case "name":
        return this.emitNode(
          ExpressionTag.Name,
          this.symbols.intern(expression.name),
          [],
          parent,
          expression.span,
        );
      case "lambda": {
        const firstParameter = this.parameterWords.length;
        for (const [parameterIndex, parameter] of expression.parameters.entries()) {
          if (typeof parameter !== "string") {
            throw new TypeError(
              `functional lambda parameter ${parameterIndex} must be a string; received ${
                JSON.stringify(parameter)
              }`,
            );
          }
          this.parameterWords.push(this.symbols.intern(parameter));
        }
        const node = this.reserveNode(
          ExpressionTag.Lambda,
          firstParameter,
          parent,
          expression.span,
        );
        const body = this.emit(expression.body, node);
        this.setChildren(node, [body, expression.parameters.length]);
        return node;
      }
      case "let": {
        const node = this.reserveNode(
          ExpressionTag.Let,
          this.symbols.intern(expression.name),
          parent,
          expression.span,
        );
        const value = this.emit(expression.value, node);
        const body = this.emit(expression.body, node);
        this.setChildren(node, [value, body]);
        return node;
      }
      case "sequence": {
        const node = this.reserveNode(
          ExpressionTag.Sequence,
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
          ExpressionTag.LetRec,
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
        const likelihood = expression.likely === "consequent"
          ? BranchLikelihood.Consequent
          : expression.likely === "alternate"
          ? BranchLikelihood.Alternate
          : BranchLikelihood.None;
        const node = this.reserveNode(ExpressionTag.If, likelihood, parent, expression.span);
        const condition = this.emit(expression.condition, node);
        const consequent = this.emit(expression.consequent, node);
        const alternate = this.emit(expression.alternate, node);
        this.setChildren(node, [condition, consequent, alternate]);
        return node;
      }
      case "apply": {
        const applicationSegments: {
          readonly arguments: readonly SurfaceExpression[];
        }[] = [{
          arguments: expression.arguments,
        }];
        let callee = expression.callee;
        while (callee.kind === "apply") {
          applicationSegments.push({
            arguments: callee.arguments,
          });
          callee = callee.callee;
        }
        applicationSegments.reverse();
        const arguments_ = applicationSegments.flatMap((segment) => segment.arguments);
        return this.emitApplication(
          callee,
          arguments_,
          parent,
          expression.span,
        );
      }
      case "unary": {
        return this.emitPrim(
          unaryPrimop(expression.operator),
          [expression.value],
          parent,
          expression.span,
          expression.operator === UnaryOperator.NegateWholeNumberF64
            ? this.requiredTypeIndex(WHOLE_NUMBER_F64_TYPE_NAME)
            : NO_INDEX,
        );
      }
      case "binary": {
        const auxiliaryType = (
            expression.operator >= BinaryOperator.EqualWholeNumberF64 &&
            expression.operator <= BinaryOperator.RemainderWholeNumberF64
          )
          ? this.requiredTypeIndex(WHOLE_NUMBER_F64_TYPE_NAME)
          : NO_INDEX;
        return this.emitPrim(
          binaryPrimop(expression.operator),
          [expression.left, expression.right],
          parent,
          expression.span,
          auxiliaryType,
        );
      }
      case "text-append":
      case "bytes-append": {
        return this.emitPrim(
          BufferAppendPrimop,
          [expression.left, expression.right],
          parent,
          expression.span,
          this.requiredTypeIndex(
            expression.kind === "text-append" ? TEXT_TYPE_NAME : BYTES_TYPE_NAME,
          ),
        );
      }
      case "store-new": {
        return this.emitPrim(
          StoreNewPrimop,
          [expression.length, expression.initial],
          parent,
          expression.span,
          this.requiredTypeIndex(STORE_TYPE_NAME),
        );
      }
      case "store-empty":
        return this.emitPrim(
          StoreEmptyPrimop,
          [],
          parent,
          expression.span,
          this.requiredTypeIndex(STORE_TYPE_NAME),
        );
      case "store-length": {
        return this.emitPrim(
          StoreLengthPrimop,
          [expression.store],
          parent,
          expression.span,
          this.requiredTypeIndex(STORE_TYPE_NAME),
        );
      }
      case "store-read": {
        return this.emitPrim(
          StoreReadPrimop,
          [expression.store, expression.index],
          parent,
          expression.span,
          this.requiredTypeIndex(STORE_TYPE_NAME),
        );
      }
      case "store-write": {
        return this.emitPrim(
          StoreWritePrimop,
          [expression.store, expression.index, expression.value],
          parent,
          expression.span,
          this.requiredTypeIndex(STORE_TYPE_NAME),
        );
      }
      case "store-grow": {
        return this.emitPrim(
          StoreGrowPrimop,
          [expression.store, expression.length, expression.initial],
          parent,
          expression.span,
          this.requiredTypeIndex(STORE_TYPE_NAME),
        );
      }
      case "numeric-convert": {
        return this.emitPrim(
          numericConversionPrimop(expression.conversion),
          [expression.value],
          parent,
          expression.span,
        );
      }
      case "case": {
        const firstAlternative = this.caseAlternativeWords.length /
          CASE_ALTERNATIVE_WORD_LENGTH;
        const node = this.reserveNode(
          ExpressionTag.Case,
          firstAlternative,
          parent,
          expression.span,
        );
        for (let armIndex = 0; armIndex < expression.arms.length; armIndex++) {
          for (let word = 0; word < CASE_ALTERNATIVE_WORD_LENGTH; word++) {
            this.caseAlternativeWords.push(NO_INDEX);
          }
        }
        const value = this.emit(expression.value, node);
        for (const [armIndex, arm] of expression.arms.entries()) {
          const constructor = this.constructorIndices.get(arm.constructor);
          if (constructor === undefined) {
            throw new Error(
              `functional case alternative ${armIndex} references unknown constructor ${
                JSON.stringify(arm.constructor)
              }`,
            );
          }
          const firstBinder = this.caseBinderWords.length;
          for (const binder of arm.binders) {
            this.caseBinderWords.push(this.symbols.intern(binder));
          }
          const body = this.emit(arm.body, node);
          const alternativeOffset = (firstAlternative + armIndex) *
            CASE_ALTERNATIVE_WORD_LENGTH;
          this.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.Constructor] =
            constructor;
          this.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.FirstBinder] =
            firstBinder;
          this.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.BinderCount] =
            arm.binders.length;
          this.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.Body] = body;
          this.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.StartByte] =
            arm.span?.startByte ?? expression.span?.startByte ?? 0;
          this.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.EndByte] =
            arm.span?.endByte ?? expression.span?.endByte ?? 0;
        }
        this.setChildren(node, [value, expression.arms.length]);
        return node;
      }
    }
  }

  private emitNode(
    tag: number,
    payload: number,
    children: readonly number[],
    parent: number,
    span: Span | undefined,
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

  private emitPrim(
    opcode: number,
    operands: readonly SurfaceExpression[],
    parent: number,
    span: Span | undefined,
    auxiliaryType = NO_INDEX,
  ): number {
    const firstOperand = this.argumentWords.length / ARGUMENT_WORD_LENGTH;
    for (let operand = 0; operand < operands.length; operand++) {
      this.argumentWords.push(NO_INDEX, EvaluationMode.StrictEager);
    }
    const node = this.reserveNode(ExpressionTag.Prim, opcode, parent, span);
    for (const [operandOffset, operand] of operands.entries()) {
      const operandNode = this.emit(operand, node);
      const recordOffset = (firstOperand + operandOffset) * ARGUMENT_WORD_LENGTH;
      this.argumentWords[recordOffset + ArgumentWord.Node] = operandNode;
    }
    this.setChildren(node, [firstOperand, operands.length, auxiliaryType]);
    return node;
  }

  private emitApplication(
    callee: SurfaceExpression,
    arguments_: readonly SurfaceExpression[],
    parent: number,
    span: Span | undefined,
  ): number {
    const arity = callee.kind === "name" ? this.callableArities.get(callee.name) : undefined;
    if (arity !== undefined && arguments_.length < arity) {
      const parameters = Array.from(
        { length: arity - arguments_.length },
        () => `$eta${this.etaExpansion++}`,
      );
      return this.emit({
        kind: "lambda",
        parameters,
        body: {
          kind: "apply",
          callee,
          arguments: [
            ...arguments_,
            ...parameters.map((name) => ({
              kind: "name" as const,
              name,
              ...(span ? { span } : {}),
            })),
          ],
          ...(span === undefined ? {} : { span }),
        },
        ...(span === undefined ? {} : { span }),
      }, parent);
    }
    if (arity !== undefined && arguments_.length > arity) {
      const exactApplication: SurfaceExpression = {
        kind: "apply",
        callee,
        arguments: arguments_.slice(0, arity),
        ...(span === undefined ? {} : { span }),
      };
      return this.emitPackedApplication(
        exactApplication,
        arguments_.slice(arity),
        parent,
        span,
      );
    }
    return this.emitPackedApplication(callee, arguments_, parent, span);
  }

  private emitPackedApplication(
    callee: SurfaceExpression,
    arguments_: readonly SurfaceExpression[],
    parent: number,
    span: Span | undefined,
  ): number {
    const firstArgument = this.argumentWords.length / ARGUMENT_WORD_LENGTH;
    for (let argument = 0; argument < arguments_.length; argument++) {
      this.argumentWords.push(NO_INDEX, NO_INDEX);
    }
    const node = this.reserveNode(ExpressionTag.Apply, firstArgument, parent, span);
    const calleeNode = this.emit(callee, node);
    for (const [argumentIndex, argument] of arguments_.entries()) {
      const argumentOffset = (firstArgument + argumentIndex) * ARGUMENT_WORD_LENGTH;
      this.argumentWords[argumentOffset + ArgumentWord.Node] = this.emit(argument, node);
      this.argumentWords[argumentOffset + ArgumentWord.EvaluationMode] =
        EvaluationMode.LazyCallByNeed;
    }
    this.setChildren(node, [calleeNode, arguments_.length]);
    return node;
  }

  private reserveNode(
    tag: number,
    payload: number,
    parent: number,
    span?: Span,
  ): number {
    const node = this.nodeCount;
    if (node >= MAXIMUM_EXPRESSION_NODES) {
      throw new RangeError(
        `functional surface module exceeds ${MAXIMUM_EXPRESSION_NODES} expression nodes`,
      );
    }
    this.words.push(
      tag,
      span?.startByte ?? 0,
      span?.endByte ?? 0,
      payload,
      NO_INDEX,
      NO_INDEX,
      NO_INDEX,
      parent,
    );
    return node;
  }

  private setChildren(node: number, children: readonly number[]): void {
    if (children.length > 3) {
      throw new Error(`functional surface node ${node} has ${children.length} children`);
    }
    const offset = node * NODE_WORD_LENGTH + NodeWord.Child0;
    for (const [childIndex, child] of children.entries()) {
      this.words[offset + childIndex] = child;
    }
  }
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
  schema: TypeSchema,
  span: Span | undefined,
): SourceType {
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

type SurfaceBuilderBase = Readonly<{
  /**
   * Returns a builder that stamps `span` on *every* node each helper produces, including the
   * interior spine of a fold or desugaring. Every surface node kind already carries an optional
   * span; without this a frontend that tracks source locations has to abandon the builder and
   * hand-write node literals, and stamping only the outermost node would silently lose a span per
   * curried lambda parameter and per extra application argument.
   */
  at(span: Span): SurfaceBuilder;
  integer(value: number): SurfaceExpression;
  signedInteger64(value: bigint): SurfaceExpression;
  float32(value: number): SurfaceExpression;
  float64(value: number): SurfaceExpression;
  wholeNumberF64(value: number): SurfaceExpression;
  boolean(value: boolean): SurfaceExpression;
  text(value: string): SurfaceExpression;
  bytes(value: Uint8Array): SurfaceExpression;
  runtimeFault(message: string): SurfaceExpression;
  unreachable(message: string): SurfaceExpression;
  name(name: string): SurfaceExpression;
  lambda(
    parameters: string | readonly string[],
    body: SurfaceExpression,
  ): SurfaceExpression;
  delay(value: SurfaceExpression): SurfaceExpression;
  force(value: SurfaceExpression): SurfaceExpression;
  apply(
    callee: SurfaceExpression,
    ...arguments_: readonly SurfaceExpression[]
  ): SurfaceExpression;
  /**
   * `let`, `if`, and `case` are the three shapes a frontend cannot express with the value helpers,
   * so without them a lowering falls back to hand-written node literals and has to remember the
   * span on each one by hand.
   */
  let(
    name: string,
    value: SurfaceExpression,
    body: SurfaceExpression,
  ): SurfaceExpression;
  sequence(
    name: string,
    value: SurfaceExpression,
    body: SurfaceExpression,
  ): SurfaceExpression;
  /**
   * Shares a forward continuation. Calls produced by `jump` are ordinary typed applications; the
   * Wasm backend contifies them when every use is saturated and in tail position.
   */
  join(
    name: string,
    parameter: string,
    body: SurfaceExpression,
    continuation: SurfaceExpression,
  ): SurfaceExpression;
  jump(name: string, value: SurfaceExpression): SurfaceExpression;
  /**
   * Installs lexical effect evidence. Calls through `operation` use `implementation`; passing that
   * binding through higher-order code keeps the replacement in scope and can discharge the effect.
   * Calling a function that already closed over the global operation is not dynamically
   * intercepted.
   */
  withEffectHandler(
    operation: string,
    implementation: SurfaceExpression,
    body: SurfaceExpression,
  ): SurfaceExpression;
  if(
    condition: SurfaceExpression,
    consequent: SurfaceExpression,
    alternate: SurfaceExpression,
    options?: { readonly likely: "consequent" | "alternate" },
  ): SurfaceExpression;
  /**
   * Arms and the `otherwise` default carry their own optional spans, so `at` fills in only the ones
   * a caller left blank rather than overwriting a more precise arm span.
   */
  case(
    value: SurfaceExpression,
    arms: readonly SurfaceCaseArm[],
    otherwise?: SurfaceCaseDefault,
  ): SurfaceExpression;
  binary(
    operator: BinaryOperator,
    left: SurfaceExpression,
    right: SurfaceExpression,
  ): SurfaceExpression;
  unary(
    operator: UnaryOperator,
    value: SurfaceExpression,
  ): SurfaceExpression;
  convert(
    conversion: NumericConversion,
    value: SurfaceExpression,
  ): SurfaceExpression;
  equal(
    left: SurfaceExpression,
    right: SurfaceExpression,
  ): SurfaceExpression;
  structuralEqual(
    left: SurfaceExpression,
    right: SurfaceExpression,
  ): SurfaceExpression;
  storeNew(
    length: SurfaceExpression,
    initial: SurfaceExpression,
  ): SurfaceExpression;
  /** Allocates a zero-length `Store a`; surrounding constraints infer `a`. */
  storeEmpty(): SurfaceExpression;
  storeLength(store: SurfaceExpression): SurfaceExpression;
  storeRead(
    store: SurfaceExpression,
    index: SurfaceExpression,
  ): SurfaceExpression;
  storeWrite(
    store: SurfaceExpression,
    index: SurfaceExpression,
    value: SurfaceExpression,
  ): SurfaceExpression;
  storeGrow(
    store: SurfaceExpression,
    length: SurfaceExpression,
    initial: SurfaceExpression,
  ): SurfaceExpression;
}>;

export type SurfaceBuilder = SurfaceBuilderBase & Readonly<StructuralRecordSurface>;

function stampSpan<Value extends { readonly span?: Span }>(value: Value, span: Span): Value {
  return value.span === undefined ? { ...value, span } : value;
}

function createSurface(span: Span | undefined): SurfaceBuilder {
  const spanned = span === undefined ? {} : { span };
  const builder = {
    at(next: Span): SurfaceBuilder {
      return createSurface(next);
    },
    integer(value: number): SurfaceExpression {
      return { kind: "integer", value, ...spanned };
    },
    signedInteger64(value: bigint): SurfaceExpression {
      return { kind: "signed-integer-64", value, ...spanned };
    },
    float32(value: number): SurfaceExpression {
      return { kind: "float-32", value, ...spanned };
    },
    float64(value: number): SurfaceExpression {
      return { kind: "float-64", value, ...spanned };
    },
    wholeNumberF64(value: number): SurfaceExpression {
      return { kind: "whole-number-f64", value, ...spanned };
    },
    boolean(value: boolean): SurfaceExpression {
      return { kind: "boolean", value, ...spanned };
    },
    name(name: string): SurfaceExpression {
      return { kind: "name", name, ...spanned };
    },
    lambda(
      parameters: string | readonly string[],
      body: SurfaceExpression,
    ): SurfaceExpression {
      const names = typeof parameters === "string" ? [parameters] : parameters;
      return { kind: "lambda", parameters: [...names], body, ...spanned };
    },
    delay(value: SurfaceExpression): SurfaceExpression {
      return {
        kind: "apply",
        callee: { kind: "name", name: THUNK_CONSTRUCTOR_NAME, ...spanned },
        arguments: [value],
        ...spanned,
      };
    },
    force(value: SurfaceExpression): SurfaceExpression {
      const valueName = "$forcedThunkValue";
      return {
        kind: "case",
        value,
        arms: [{
          constructor: THUNK_CONSTRUCTOR_NAME,
          binders: [valueName],
          body: { kind: "name", name: valueName, ...spanned },
          ...spanned,
        }],
        ...spanned,
      };
    },
    apply(
      callee: SurfaceExpression,
      ...arguments_: readonly SurfaceExpression[]
    ): SurfaceExpression {
      return { kind: "apply", callee, arguments: arguments_, ...spanned };
    },
    let(
      name: string,
      value: SurfaceExpression,
      body: SurfaceExpression,
    ): SurfaceExpression {
      return {
        kind: "let",
        name,
        value,
        body,
        ...spanned,
      };
    },
    sequence(
      name: string,
      value: SurfaceExpression,
      body: SurfaceExpression,
    ): SurfaceExpression {
      return {
        kind: "sequence",
        name,
        value,
        body,
        ...spanned,
      };
    },
    join(
      name: string,
      parameter: string,
      body: SurfaceExpression,
      continuation: SurfaceExpression,
    ): SurfaceExpression {
      return {
        kind: "let",
        name,
        value: {
          kind: "lambda",
          parameters: [parameter],
          body: continuation,
          ...spanned,
        },
        body,
        ...spanned,
      };
    },
    jump(name: string, value: SurfaceExpression): SurfaceExpression {
      return {
        kind: "apply",
        callee: { kind: "name", name, ...spanned },
        arguments: [value],
        ...spanned,
      };
    },
    withEffectHandler(
      operation: string,
      implementation: SurfaceExpression,
      body: SurfaceExpression,
    ): SurfaceExpression {
      return {
        kind: "let",
        name: operation,
        value: implementation,
        body,
        ...spanned,
      };
    },
    if(
      condition: SurfaceExpression,
      consequent: SurfaceExpression,
      alternate: SurfaceExpression,
      options?: { readonly likely: "consequent" | "alternate" },
    ): SurfaceExpression {
      return {
        kind: "if",
        condition,
        consequent,
        alternate,
        ...(options === undefined ? {} : { likely: options.likely }),
        ...spanned,
      };
    },
    case(
      value: SurfaceExpression,
      arms: readonly SurfaceCaseArm[],
      otherwise?: SurfaceCaseDefault,
    ): SurfaceExpression {
      return {
        kind: "case",
        value,
        arms: span === undefined ? arms : arms.map((arm) => stampSpan(arm, span)),
        ...(otherwise === undefined
          ? {}
          : { otherwise: span === undefined ? otherwise : stampSpan(otherwise, span) }),
        ...spanned,
      };
    },
    binary(
      operator: BinaryOperator,
      left: SurfaceExpression,
      right: SurfaceExpression,
    ): SurfaceExpression {
      return { kind: "binary", operator, left, right, ...spanned };
    },
    unary(
      operator: UnaryOperator,
      value: SurfaceExpression,
    ): SurfaceExpression {
      return { kind: "unary", operator, value, ...spanned };
    },
    convert(
      conversion: NumericConversion,
      value: SurfaceExpression,
    ): SurfaceExpression {
      return { kind: "numeric-convert", conversion, value, ...spanned };
    },
    equal(
      left: SurfaceExpression,
      right: SurfaceExpression,
    ): SurfaceExpression {
      return { kind: "binary", operator: BinaryOperator.Equal, left, right, ...spanned };
    },
    structuralEqual(
      left: SurfaceExpression,
      right: SurfaceExpression,
    ): SurfaceExpression {
      return {
        kind: "binary",
        operator: BinaryOperator.StructuralEqual,
        left,
        right,
        ...spanned,
      };
    },
    storeNew(
      length: SurfaceExpression,
      initial: SurfaceExpression,
    ): SurfaceExpression {
      return { kind: "store-new", length, initial, ...spanned };
    },
    storeEmpty(): SurfaceExpression {
      return { kind: "store-empty", ...spanned };
    },
    storeLength(store: SurfaceExpression): SurfaceExpression {
      return { kind: "store-length", store, ...spanned };
    },
    storeRead(
      store: SurfaceExpression,
      index: SurfaceExpression,
    ): SurfaceExpression {
      return { kind: "store-read", store, index, ...spanned };
    },
    storeWrite(
      store: SurfaceExpression,
      index: SurfaceExpression,
      value: SurfaceExpression,
    ): SurfaceExpression {
      return {
        kind: "store-write",
        store,
        index,
        value,
        ...spanned,
      };
    },
    storeGrow(
      store: SurfaceExpression,
      length: SurfaceExpression,
      initial: SurfaceExpression,
    ): SurfaceExpression {
      return {
        kind: "store-grow",
        store,
        length,
        initial,
        ...spanned,
      };
    },
    text(value: string): SurfaceExpression {
      return { kind: "text", value, ...spanned };
    },
    bytes(value: Uint8Array): SurfaceExpression {
      return { kind: "bytes", value: value.slice(), ...spanned };
    },
    runtimeFault(message: string): SurfaceExpression {
      return { kind: "runtime-fault", category: "explicit", message, ...spanned };
    },
    unreachable(message: string): SurfaceExpression {
      return { kind: "runtime-fault", category: "unreachable", message, ...spanned };
    },
  };
  return Object.freeze({
    ...builder,
    ...createStructuralRecordSurface(builder),
  });
}

export const surface: SurfaceBuilder = createSurface(undefined);

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
