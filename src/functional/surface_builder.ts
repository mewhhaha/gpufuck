import {
  type EncodedFunctionalModule,
  FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
  FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  FUNCTIONAL_MODULE_ABI_VERSION,
  FUNCTIONAL_NO_INDEX,
  FUNCTIONAL_NODE_WORD_LENGTH,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  FunctionalExpressionTag,
  FunctionalNodeWord,
  type FunctionalSourceType,
  type FunctionalSpan,
  FunctionalTypecheckingProfile,
  type FunctionalTypeSchema,
} from "./abi.ts";
import {
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_INIT_TYPE_NAME,
  functionalHostFieldType,
  type FunctionalSurfaceModuleOptions,
  normalizeFunctionalHostCapabilities,
} from "./host_contract.ts";

export type FunctionalSurfaceExpression =
  | { readonly kind: "integer"; readonly value: number; readonly span?: FunctionalSpan }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span?: FunctionalSpan }
  | { readonly kind: "name"; readonly name: string; readonly span?: FunctionalSpan }
  | {
    readonly kind: "lambda";
    readonly parameter: string;
    readonly body: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "let";
    readonly name: string;
    readonly value: FunctionalSurfaceExpression;
    readonly body: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "let-rec";
    readonly name: string;
    readonly value: FunctionalSurfaceExpression;
    readonly body: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: FunctionalSurfaceExpression;
    readonly consequent: FunctionalSurfaceExpression;
    readonly alternate: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "apply";
    readonly callee: FunctionalSurfaceExpression;
    readonly argument: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: FunctionalBinaryOperator;
    readonly left: FunctionalSurfaceExpression;
    readonly right: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "case";
    readonly value: FunctionalSurfaceExpression;
    readonly arms: readonly FunctionalSurfaceCaseArm[];
    readonly span?: FunctionalSpan;
  };

export interface FunctionalSurfaceCaseArm {
  readonly constructor: string;
  readonly binders: readonly string[];
  readonly body: FunctionalSurfaceExpression;
  readonly span?: FunctionalSpan;
}

export interface FunctionalSurfaceDefinition {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly annotation: FunctionalTypeSchema | null;
  readonly body: FunctionalSurfaceExpression;
  readonly span?: FunctionalSpan;
}

export interface FunctionalSurfaceTypeDeclaration {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly span?: FunctionalSpan;
  readonly constructors: readonly {
    readonly name: string;
    readonly span?: FunctionalSpan;
    readonly fields: readonly {
      readonly name: string;
      readonly type: FunctionalTypeSchema;
      readonly span?: FunctionalSpan;
    }[];
    readonly result?: FunctionalTypeSchema;
  }[];
}

export function buildFunctionalSurfaceModule(
  definitions: readonly FunctionalSurfaceDefinition[],
  typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[],
  entryName: string,
  sourceByteLength: number,
  options: FunctionalSurfaceModuleOptions = {},
): EncodedFunctionalModule {
  const hostCapabilities = normalizeFunctionalHostCapabilities(options.hostCapabilities);
  const usesRank2Types =
    definitions.some((definition) =>
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
  for (const reservedName of ["$UnitType", "$TupleType", FUNCTIONAL_INIT_TYPE_NAME]) {
    if (declaredNames.has(reservedName)) {
      throw new Error(
        `functional surface cannot declare reserved type ${JSON.stringify(reservedName)}`,
      );
    }
  }
  const encodedTypeDeclarations = [
    ...typeDeclarations,
    ...(hostCapabilities.length === 0 ? [] : [hostInitTypeDeclaration(hostCapabilities)]),
    ...primitiveTypeDeclarations(sourceByteLength),
  ];
  const symbols = new SurfaceSymbolTable();
  for (const definition of definitions) symbols.intern(definition.name);
  symbols.intern(entryName);
  for (const declaration of encodedTypeDeclarations) {
    symbols.intern(declaration.name);
    for (const constructor of declaration.constructors) symbols.intern(constructor.name);
  }

  const encoder = new SurfaceExpressionEncoder(symbols);
  const definitionWords: number[] = [];
  for (const definition of definitions) {
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
    evaluationProfile: FunctionalEvaluationProfile.LazyCallByNeed,
    typecheckingProfile: usesRank2Types
      ? FunctionalTypecheckingProfile.PredicativeRank2Indexed
      : FunctionalTypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
    hostCapabilities,
    nodeWords: Uint32Array.from(encoder.words),
    definitionWords: Uint32Array.from(definitionWords),
    typeWords: Uint32Array.from(typeWords),
    constructorWords: Uint32Array.from(constructorWords),
    nodeCount: encoder.nodeCount,
    definitionCount: definitions.length,
    typeCount: encodedTypeDeclarations.length,
    constructorCount: constructorWords.length / FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
    entrySymbol: symbols.id(entryName),
    symbolNames: symbols.names,
    definitionTypes: definitions.map((definition) => ({
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
    case "boolean":
    case "unit":
    case "parameter":
      return false;
  }
}

function hostInitTypeDeclaration(
  capabilities: ReturnType<typeof normalizeFunctionalHostCapabilities>,
): FunctionalSurfaceTypeDeclaration {
  return {
    name: FUNCTIONAL_INIT_TYPE_NAME,
    parameters: [],
    constructors: [{
      name: FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
      fields: capabilities.flatMap((capability) =>
        capability.fields.map((field) => ({
          name: `${capability.name}.${field.name}`,
          type: functionalHostFieldType(field),
        }))
      ),
    }],
  };
}

function primitiveTypeDeclarations(
  sourceByteLength: number,
): readonly FunctionalSurfaceTypeDeclaration[] {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return [
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

  constructor(private readonly symbols: SurfaceSymbolTable) {}

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
    const parameter = parameters[parameterIndex];
    if (parameter === undefined) return this.emit(body, parent);
    const node = this.reserveNode(
      FunctionalExpressionTag.Lambda,
      this.symbols.intern(parameter),
      parent,
      span,
    );
    const child = this.emitParameters(parameters, parameterIndex + 1, body, node, span);
    this.setChildren(node, [child]);
    return node;
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
      case "boolean":
        return this.emitNode(
          FunctionalExpressionTag.Boolean,
          expression.value ? 1 : 0,
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
        const node = this.reserveNode(
          FunctionalExpressionTag.Let,
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
      case "if": {
        const node = this.reserveNode(FunctionalExpressionTag.If, 0, parent, expression.span);
        const condition = this.emit(expression.condition, node);
        const consequent = this.emit(expression.consequent, node);
        const alternate = this.emit(expression.alternate, node);
        this.setChildren(node, [condition, consequent, alternate]);
        return node;
      }
      case "apply": {
        const node = this.reserveNode(FunctionalExpressionTag.Apply, 0, parent, expression.span);
        const callee = this.emit(expression.callee, node);
        const argument = this.emit(expression.argument, node);
        this.setChildren(node, [callee, argument]);
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
    const arm = arms[armIndex];
    if (arm === undefined) return FUNCTIONAL_NO_INDEX;
    const node = this.reserveNode(
      FunctionalExpressionTag.CaseArm,
      this.symbols.intern(arm.constructor),
      parent,
      arm.span,
    );
    const body = this.emitPatternBindings(arm.binders, arm.body, node);
    const nextArm = this.emitCaseArms(arms, armIndex + 1, node);
    this.setChildren(node, [body, nextArm]);
    return node;
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

  private reserveNode(
    tag: number,
    payload: number,
    parent: number,
    span?: FunctionalSpan,
  ): number {
    const node = this.nodeCount;
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

export const surface = {
  integer(value: number): FunctionalSurfaceExpression {
    return { kind: "integer", value };
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
  equal(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    return { kind: "binary", operator: FunctionalBinaryOperator.Equal, left, right };
  },
};
