import {
  type EncodedFunctionalModule,
  FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
  FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  FUNCTIONAL_MODULE_ABI_VERSION,
  FUNCTIONAL_NO_INDEX,
  FUNCTIONAL_NODE_WORD_LENGTH,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  FunctionalExpressionTag,
  FunctionalNodeWord,
  type FunctionalSourceType,
  FunctionalTypecheckingProfile,
  type FunctionalTypeSchema,
} from "./abi.ts";

export type FunctionalSurfaceExpression =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "name"; readonly name: string }
  | {
    readonly kind: "let";
    readonly name: string;
    readonly value: FunctionalSurfaceExpression;
    readonly body: FunctionalSurfaceExpression;
  }
  | {
    readonly kind: "if";
    readonly condition: FunctionalSurfaceExpression;
    readonly consequent: FunctionalSurfaceExpression;
    readonly alternate: FunctionalSurfaceExpression;
  }
  | {
    readonly kind: "apply";
    readonly callee: FunctionalSurfaceExpression;
    readonly argument: FunctionalSurfaceExpression;
  }
  | {
    readonly kind: "binary";
    readonly operator: FunctionalBinaryOperator;
    readonly left: FunctionalSurfaceExpression;
    readonly right: FunctionalSurfaceExpression;
  }
  | {
    readonly kind: "case";
    readonly value: FunctionalSurfaceExpression;
    readonly arms: readonly FunctionalSurfaceCaseArm[];
  };

export interface FunctionalSurfaceCaseArm {
  readonly constructor: string;
  readonly binders: readonly string[];
  readonly body: FunctionalSurfaceExpression;
}

export interface FunctionalSurfaceDefinition {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly annotation: FunctionalTypeSchema;
  readonly body: FunctionalSurfaceExpression;
}

export interface FunctionalSurfaceTypeDeclaration {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly {
    readonly name: string;
    readonly fields: readonly {
      readonly name: string;
      readonly type: FunctionalTypeSchema;
    }[];
  }[];
}

export function buildFunctionalSurfaceModule(
  definitions: readonly FunctionalSurfaceDefinition[],
  typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[],
  entryName: string,
  sourceByteLength: number,
): EncodedFunctionalModule {
  const symbols = new SurfaceSymbolTable();
  for (const definition of definitions) symbols.intern(definition.name);
  symbols.intern(entryName);
  for (const declaration of typeDeclarations) {
    symbols.intern(declaration.name);
    for (const constructor of declaration.constructors) symbols.intern(constructor.name);
  }

  const encoder = new SurfaceExpressionEncoder(symbols);
  const definitionWords: number[] = [];
  for (const definition of definitions) {
    const rootNode = encoder.emitDefinitionBody(definition.parameters, definition.body);
    definitionWords.push(symbols.id(definition.name), rootNode, 0, 0);
  }

  const typeWords: number[] = [];
  const constructorWords: number[] = [];
  for (const [typeIndex, declaration] of typeDeclarations.entries()) {
    const firstConstructor = constructorWords.length / FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH;
    typeWords.push(
      symbols.id(declaration.name),
      firstConstructor,
      declaration.constructors.length,
      0,
      0,
    );
    for (const constructor of declaration.constructors) {
      constructorWords.push(
        symbols.id(constructor.name),
        typeIndex,
        constructor.fields.length,
        0,
        0,
      );
    }
  }

  return {
    abiVersion: FUNCTIONAL_MODULE_ABI_VERSION,
    sourceByteLength,
    evaluationProfile: FunctionalEvaluationProfile.LazyCallByNeed,
    typecheckingProfile: FunctionalTypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
    nodeWords: Uint32Array.from(encoder.words),
    definitionWords: Uint32Array.from(definitionWords),
    typeWords: Uint32Array.from(typeWords),
    constructorWords: Uint32Array.from(constructorWords),
    nodeCount: encoder.nodeCount,
    definitionCount: definitions.length,
    typeCount: typeDeclarations.length,
    constructorCount: constructorWords.length / FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
    entrySymbol: symbols.id(entryName),
    symbolNames: symbols.names,
    definitionTypes: definitions.map((definition) => ({
      annotation: sourceType(definition.annotation),
    })),
    typeDeclarations: typeDeclarations.map((declaration) => ({
      name: declaration.name,
      parameters: declaration.parameters,
      constructors: declaration.constructors.map((constructor) => ({
        name: constructor.name,
        fields: constructor.fields.map((field) => ({
          name: field.name,
          type: sourceType(field.type),
        })),
      })),
    })),
  };
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
  ): number {
    return this.emitParameters(parameters, 0, body, FUNCTIONAL_NO_INDEX);
  }

  private emitParameters(
    parameters: readonly string[],
    parameterIndex: number,
    body: FunctionalSurfaceExpression,
    parent: number,
  ): number {
    const parameter = parameters[parameterIndex];
    if (parameter === undefined) return this.emit(body, parent);
    const node = this.reserveNode(
      FunctionalExpressionTag.Lambda,
      this.symbols.intern(parameter),
      parent,
    );
    const child = this.emitParameters(parameters, parameterIndex + 1, body, node);
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
        );
      case "boolean":
        return this.emitNode(
          FunctionalExpressionTag.Boolean,
          expression.value ? 1 : 0,
          [],
          parent,
        );
      case "name":
        return this.emitNode(
          FunctionalExpressionTag.Name,
          this.symbols.intern(expression.name),
          [],
          parent,
        );
      case "let": {
        const node = this.reserveNode(
          FunctionalExpressionTag.Let,
          this.symbols.intern(expression.name),
          parent,
        );
        const value = this.emit(expression.value, node);
        const body = this.emit(expression.body, node);
        this.setChildren(node, [value, body]);
        return node;
      }
      case "if": {
        const node = this.reserveNode(FunctionalExpressionTag.If, 0, parent);
        const condition = this.emit(expression.condition, node);
        const consequent = this.emit(expression.consequent, node);
        const alternate = this.emit(expression.alternate, node);
        this.setChildren(node, [condition, consequent, alternate]);
        return node;
      }
      case "apply": {
        const node = this.reserveNode(FunctionalExpressionTag.Apply, 0, parent);
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
        );
        const left = this.emit(expression.left, node);
        const right = this.emit(expression.right, node);
        this.setChildren(node, [left, right]);
        return node;
      }
      case "case": {
        const node = this.reserveNode(FunctionalExpressionTag.Case, 0, parent);
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
  ): number {
    const node = this.reserveNode(tag, payload, parent);
    this.setChildren(node, children);
    return node;
  }

  private reserveNode(tag: number, payload: number, parent: number): number {
    const node = this.nodeCount;
    this.words.push(
      tag,
      0,
      0,
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

function sourceType(schema: FunctionalTypeSchema): FunctionalSourceType {
  return { ...schema, startByte: 0, endByte: 0 } as FunctionalSourceType;
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
