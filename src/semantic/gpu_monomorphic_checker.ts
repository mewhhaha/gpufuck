/**
 * A checking-only path for modules whose top-level types are already concrete.
 *
 * The host produces a topologically ordered witness for Core's independent type equations. One GPU
 * dispatch checks every term, witness record, and equation without mutation or successful-path
 * atomics, then returns only one status record per module. An invalid or unavailable witness sends
 * the module through full inference, so this remains an optimization rather than another type rule.
 */
import {
  ArgumentWord,
  BinaryOperator,
  CASE_ALTERNATIVE_WORD_LENGTH,
  CaseAlternativeWord,
  CONSTRUCTOR_WORD_LENGTH,
  ConstructorWord,
  CoreTag,
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type EncodedSemanticSurface,
  NO_INDEX,
  NumericConversion,
  type Type,
  type TypeSchema,
  UnaryOperator,
} from "./abi.ts";
import type { CoreNode } from "./compiler_module.ts";
import { primopDeclaration, PrimopFamily } from "./primops.ts";
import { concreteType } from "../functional/schema_contract.ts";

const WORKGROUP_SIZE = 64;
const TERM_WORD_LENGTH = 5;
const WITNESS_TYPE_WORD_LENGTH = 4;
const CONSTRAINT_WORD_LENGTH = 3;
const PACKED_TERM_WORD_LENGTH = 6;
const PACKED_WITNESS_TYPE_WORD_LENGTH = 5;
const CHECKING_STATE_WORD_LENGTH = 7;
const CHECKING_INPUT_HEADER_WORD_LENGTH = 5;
const NO_FAILURE = 0xffff_ffff;
const UNIT_CONSTRUCTOR_NAME = "$Unit";

const TermKind = {
  Variable: 0,
  Integer: 1,
  SignedInteger64: 2,
  Float32: 3,
  Float64: 4,
  Boolean: 5,
  Unit: 6,
  Function: 7,
  Named: 8,
  Application: 9,
} as const;

interface CheckingConstraint {
  readonly left: number;
  readonly right: number;
  readonly source: number;
}

export interface TypedCoreCertificatePlan {
  readonly terms: Uint32Array<ArrayBuffer>;
  readonly assignments: Uint32Array<ArrayBuffer>;
  readonly witnessTypes: Uint32Array<ArrayBuffer>;
  readonly witnessTypeCount: number;
  readonly constraints: readonly CheckingConstraint[];
  readonly entryType: Type;
  readonly nodes: readonly CoreNode[];
}

export type TypedCoreCertificatePreparation =
  | { readonly kind: "ready"; readonly plan: TypedCoreCertificatePlan }
  | { readonly kind: "unsupported" };

interface MutableTerm {
  readonly kind: number;
  readonly payload: number;
  readonly child0: number;
  readonly child1: number;
}

interface ConstructorTemplate {
  readonly name: string;
  readonly declaration: number;
  readonly parameters: readonly string[];
  readonly fields: readonly TypeSchema[];
  readonly result?: TypeSchema;
}

interface ConstructorInstance {
  readonly fields: readonly number[];
  readonly result: number;
  readonly type: number;
}

class TypedCoreCertificatePlanner {
  readonly #surface: EncodedSemanticSurface;
  readonly #nodes: readonly CoreNode[];
  readonly #terms: MutableTerm[] = [];
  readonly #constraints: CheckingConstraint[] = [];
  readonly #nodeTypes: number[];
  readonly #definitionTypes: number[] = [];
  readonly #constructors: (ConstructorTemplate | undefined)[];
  readonly #primitiveTypes = new Map<number, number>();
  #unsupported = false;

  constructor(surface: EncodedSemanticSurface, nodes: readonly CoreNode[]) {
    this.#surface = surface;
    this.#nodes = nodes;
    this.#nodeTypes = Array.from({ length: surface.nodeCount }, () => this.#variable());
    this.#constructors = Array.from({ length: surface.constructorCount });
  }

  plan(): TypedCoreCertificatePreparation {
    for (let definition = 0; definition < this.#surface.definitionCount; definition++) {
      const annotation = this.#surface.definitionTypes[definition]?.annotation;
      if (annotation === null || annotation === undefined) return { kind: "unsupported" };
      const type = this.#schema(annotation);
      if (type === null) return { kind: "unsupported" };
      this.#definitionTypes.push(type);
    }
    this.#prepareConstructors();
    if (this.#unsupported) return { kind: "unsupported" };

    for (let definition = 0; definition < this.#surface.definitionCount; definition++) {
      const root = this.#surface.definitionWords[
        definition * DEFINITION_WORD_LENGTH + DefinitionWord.RootNode
      ];
      if (root === undefined) return { kind: "unsupported" };
      const received = this.#expression(root, []);
      this.#constrain(this.#definitionTypes[definition]!, received, root);
    }
    if (this.#unsupported) return { kind: "unsupported" };

    const entryDefinition = this.#entryDefinition();
    const entrySchema = this.#surface.definitionTypes[entryDefinition]?.annotation;
    if (entrySchema === null || entrySchema === undefined) return { kind: "unsupported" };
    let entryType: Type;
    try {
      entryType = concreteType(entrySchema);
    } catch {
      return { kind: "unsupported" };
    }
    const words = new Uint32Array(this.#terms.length * TERM_WORD_LENGTH);
    for (const [index, term] of this.#terms.entries()) {
      const base = index * TERM_WORD_LENGTH;
      words[base] = index;
      words[base + 1] = term.kind;
      words[base + 2] = term.payload;
      words[base + 3] = term.child0;
      words[base + 4] = term.child1;
    }
    const witness = solveTypeEquations(words, this.#constraints);
    if (witness === null) return { kind: "unsupported" };
    return {
      kind: "ready",
      plan: {
        terms: words,
        assignments: witness.assignments,
        witnessTypes: witness.types,
        witnessTypeCount: witness.types.length / WITNESS_TYPE_WORD_LENGTH,
        constraints: Object.freeze([...this.#constraints]),
        entryType,
        nodes: this.#nodes,
      },
    };
  }

  #prepareConstructors(): void {
    for (let constructor = 0; constructor < this.#surface.constructorCount; constructor++) {
      const declaration = this.#surface.constructorWords[
        constructor * CONSTRUCTOR_WORD_LENGTH + ConstructorWord.Type
      ];
      const encoded = this.#surface.typeDeclarations[declaration ?? NO_INDEX];
      if (declaration === undefined || encoded === undefined) {
        this.#unsupported = true;
        return;
      }
      const constructorOffset = this.#surface.constructorWords[
        constructor * CONSTRUCTOR_WORD_LENGTH + ConstructorWord.Symbol
      ];
      const constructorName = constructorOffset === undefined
        ? undefined
        : this.#surface.symbolNames[constructorOffset];
      const source = encoded.constructors.find((candidate) => candidate.name === constructorName);
      if (source === undefined) {
        this.#unsupported = true;
        return;
      }
      this.#constructors[constructor] = {
        name: source.name,
        declaration,
        parameters: encoded.parameters,
        fields: Object.freeze(source.fields.map((field) => field.type)),
        ...(source.result === undefined ? {} : { result: source.result }),
      };
    }
  }

  #expression(nodeIndex: number, environment: readonly number[]): number {
    const node = this.#nodes[nodeIndex];
    const result = this.#nodeTypes[nodeIndex];
    if (node === undefined || result === undefined) {
      this.#unsupported = true;
      return this.#variable();
    }
    switch (node.tag) {
      case CoreTag.Integer:
        this.#constrain(result, this.#primitive(TermKind.Integer), nodeIndex);
        return result;
      case CoreTag.SignedInteger64:
        this.#constrain(result, this.#primitive(TermKind.SignedInteger64), nodeIndex);
        return result;
      case CoreTag.Float32:
        this.#constrain(result, this.#primitive(TermKind.Float32), nodeIndex);
        return result;
      case CoreTag.Float64:
        this.#constrain(result, this.#primitive(TermKind.Float64), nodeIndex);
        return result;
      case CoreTag.Boolean:
        this.#constrain(result, this.#primitive(TermKind.Boolean), nodeIndex);
        return result;
      case CoreTag.Local: {
        const type = environment[node.payload];
        if (type === undefined) this.#unsupported = true;
        else this.#constrain(result, type, nodeIndex);
        return result;
      }
      case CoreTag.Global: {
        const type = this.#definitionTypes[node.payload];
        if (type === undefined) this.#unsupported = true;
        else this.#constrain(result, type, nodeIndex);
        return result;
      }
      case CoreTag.Constructor: {
        const constructor = this.#instantiateConstructor(node.payload);
        if (constructor === null) this.#unsupported = true;
        else this.#constrain(result, constructor.type, nodeIndex);
        return result;
      }
      case CoreTag.Let: {
        const value = this.#expression(node.child0, environment);
        const body = this.#expression(node.child1, [value, ...environment]);
        this.#constrain(result, body, nodeIndex);
        return result;
      }
      case CoreTag.LetRec: {
        const binding = this.#variable();
        const value = this.#expression(node.child0, [binding, ...environment]);
        this.#constrain(binding, value, nodeIndex);
        const body = this.#expression(node.child1, [binding, ...environment]);
        this.#constrain(result, body, nodeIndex);
        return result;
      }
      case CoreTag.Lambda: {
        const parameterCount = Math.max(node.child1, 1);
        const parameters = Array.from({ length: parameterCount }, () => this.#variable());
        const body = this.#expression(node.child0, [...parameters].reverse().concat(environment));
        const type = parameters.reduceRight(
          (remaining, parameter) => this.#term(TermKind.Function, 0, parameter, remaining),
          body,
        );
        this.#constrain(result, type, nodeIndex);
        if (node.child1 === 0) {
          this.#constrain(parameters[0]!, this.#primitive(TermKind.Unit), nodeIndex);
        }
        return result;
      }
      case CoreTag.Apply: {
        let callee = this.#expression(node.child0, environment);
        if (node.child1 === 0) {
          const applied = this.#term(
            TermKind.Function,
            0,
            this.#primitive(TermKind.Unit),
            result,
          );
          this.#constrain(callee, applied, nodeIndex);
          return result;
        }
        for (let offset = 0; offset < node.child1; offset++) {
          const argumentNode = this.#surface.argumentWords[
            (node.payload + offset) * 2 + ArgumentWord.Node
          ];
          if (argumentNode === undefined) {
            this.#unsupported = true;
            return result;
          }
          const argument = this.#expression(argumentNode, environment);
          const remaining = offset + 1 === node.child1 ? result : this.#variable();
          this.#constrain(
            callee,
            this.#term(TermKind.Function, 0, argument, remaining),
            nodeIndex,
          );
          callee = remaining;
        }
        return result;
      }
      case CoreTag.If: {
        const condition = this.#expression(node.child0, environment);
        const consequent = this.#expression(node.child1, environment);
        const alternate = this.#expression(node.child2, environment);
        this.#constrain(condition, this.#primitive(TermKind.Boolean), nodeIndex);
        this.#constrain(result, consequent, nodeIndex);
        this.#constrain(result, alternate, nodeIndex);
        return result;
      }
      case CoreTag.Unary:
        return this.#unary(node, nodeIndex, environment, result);
      case CoreTag.Binary:
        return this.#binary(node, nodeIndex, environment, result);
      case CoreTag.NumericConvert:
        return this.#numericConversion(node, nodeIndex, environment, result);
      case CoreTag.Prim:
        return this.#prim(node, nodeIndex, environment, result);
      case CoreTag.Case:
        return this.#case(node, nodeIndex, environment, result);
      case CoreTag.Text:
      case CoreTag.Bytes:
        this.#constrain(result, this.#term(TermKind.Named, node.child0), nodeIndex);
        return result;
      case CoreTag.RuntimeFault:
        return result;
      default:
        this.#unsupported = true;
        return result;
    }
  }

  #case(
    node: CoreNode,
    nodeIndex: number,
    environment: readonly number[],
    result: number,
  ): number {
    const subject = this.#expression(node.child0, environment);
    if (node.child1 === 0) {
      this.#unsupported = true;
      return result;
    }
    let declaration: number | undefined;
    const matchedConstructors = new Set<number>();
    for (let offset = 0; offset < node.child1; offset++) {
      const alternative = node.payload + offset;
      const base = alternative * CASE_ALTERNATIVE_WORD_LENGTH;
      const constructor = this.#surface.caseAlternativeWords[
        base + CaseAlternativeWord.Constructor
      ];
      const body = this.#surface.caseAlternativeWords[base + CaseAlternativeWord.Body];
      const binderCount = this.#surface.caseAlternativeWords[
        base + CaseAlternativeWord.BinderCount
      ];
      if (constructor === undefined || body === undefined || binderCount === undefined) {
        this.#unsupported = true;
        return result;
      }
      const template = this.#constructors[constructor];
      if (
        template === undefined || matchedConstructors.has(constructor) ||
        declaration !== undefined && template.declaration !== declaration
      ) {
        this.#unsupported = true;
        return result;
      }
      declaration = template.declaration;
      matchedConstructors.add(constructor);
      const instance = this.#instantiateConstructor(constructor);
      if (instance === null || instance.fields.length !== binderCount) {
        this.#unsupported = true;
        return result;
      }
      this.#constrain(subject, instance.result, nodeIndex);
      const arm = this.#expression(body, [...instance.fields, ...environment]);
      this.#constrain(result, arm, nodeIndex);
    }
    const declaredConstructors = declaration === undefined
      ? undefined
      : this.#surface.typeDeclarations[declaration]?.constructors.length;
    if (declaredConstructors === undefined || matchedConstructors.size !== declaredConstructors) {
      this.#unsupported = true;
    }
    return result;
  }

  #prim(
    node: CoreNode,
    nodeIndex: number,
    environment: readonly number[],
    result: number,
  ): number {
    const declaration = primopDeclaration(node.payload);
    if (declaration === undefined) {
      this.#unsupported = true;
      return result;
    }
    const operands: number[] = [];
    for (let operand = 0; operand < declaration.arity; operand++) {
      const argumentNode = this.#surface.argumentWords[
        (node.child0 + operand) * 2 + ArgumentWord.Node
      ];
      if (argumentNode === undefined) {
        this.#unsupported = true;
        return result;
      }
      operands.push(this.#expression(argumentNode, environment));
    }
    if (declaration.family === PrimopFamily.Unary) {
      return this.#numericOperation(
        declaration.operation,
        1,
        operands,
        result,
        nodeIndex,
      );
    }
    if (declaration.family === PrimopFamily.Binary) {
      return this.#numericOperation(
        declaration.operation,
        2,
        operands,
        result,
        nodeIndex,
      );
    }
    if (declaration.family === PrimopFamily.NumericConversion) {
      return this.#conversionOperation(declaration.operation, operands[0]!, result, nodeIndex);
    }
    this.#unsupported = true;
    return result;
  }

  #unary(
    node: CoreNode,
    nodeIndex: number,
    environment: readonly number[],
    result: number,
  ): number {
    const operand = this.#expression(node.child0, environment);
    return this.#numericOperation(node.payload, 1, [operand], result, nodeIndex);
  }

  #binary(
    node: CoreNode,
    nodeIndex: number,
    environment: readonly number[],
    result: number,
  ): number {
    const left = this.#expression(node.child0, environment);
    const right = this.#expression(node.child1, environment);
    return this.#numericOperation(node.payload, 2, [left, right], result, nodeIndex);
  }

  #numericConversion(
    node: CoreNode,
    nodeIndex: number,
    environment: readonly number[],
    result: number,
  ): number {
    return this.#conversionOperation(
      node.payload,
      this.#expression(node.child0, environment),
      result,
      nodeIndex,
    );
  }

  #numericOperation(
    operation: number,
    arity: 1 | 2,
    operands: readonly number[],
    result: number,
    source: number,
  ): number {
    let kind: number;
    let comparison = false;
    if (arity === 1) {
      if (operation === UnaryOperator.Negate) kind = TermKind.Integer;
      else if (operation === UnaryOperator.NegateSignedInteger64) {
        kind = TermKind.SignedInteger64;
      } else if (operation === UnaryOperator.NegateFloat64) kind = TermKind.Float64;
      else if (
        operation === UnaryOperator.NegateFloat32 ||
        operation === UnaryOperator.SquareRootFloat32
      ) kind = TermKind.Float32;
      else {
        this.#unsupported = true;
        return result;
      }
    } else if (
      operation >= BinaryOperator.EqualSignedInteger64 &&
        operation <= BinaryOperator.DivideSignedInteger64 ||
      operation >= BinaryOperator.RemainderSignedInteger64 &&
        operation <= BinaryOperator.ShiftRightUnsignedSignedInteger64
    ) {
      kind = TermKind.SignedInteger64;
      comparison = operation >= BinaryOperator.EqualSignedInteger64 &&
        operation <= BinaryOperator.GreaterEqualSignedInteger64;
    } else if (
      operation >= BinaryOperator.EqualFloat32 && operation <= BinaryOperator.DivideFloat32
    ) {
      kind = TermKind.Float32;
      comparison = operation <= BinaryOperator.GreaterEqualFloat32;
    } else if (
      operation >= BinaryOperator.EqualFloat64 && operation <= BinaryOperator.DivideFloat64 ||
      operation === BinaryOperator.RemainderFloat64
    ) {
      kind = TermKind.Float64;
      comparison = operation <= BinaryOperator.GreaterEqualFloat64;
    } else if (
      operation === BinaryOperator.StructuralEqual ||
      operation === BinaryOperator.StructuralNotEqual
    ) {
      const shared = this.#variable();
      for (const operand of operands) this.#constrain(shared, operand, source);
      this.#constrain(result, this.#primitive(TermKind.Boolean), source);
      return result;
    } else if (
      operation >= BinaryOperator.Equal && operation <= BinaryOperator.Divide ||
      operation >= BinaryOperator.Remainder && operation <= BinaryOperator.ShiftRightUnsigned
    ) {
      kind = TermKind.Integer;
      comparison = operation <= BinaryOperator.GreaterEqual;
    } else {
      this.#unsupported = true;
      return result;
    }
    const type = this.#primitive(kind);
    for (const operand of operands) this.#constrain(type, operand, source);
    this.#constrain(result, comparison ? this.#primitive(TermKind.Boolean) : type, source);
    return result;
  }

  #conversionOperation(operation: number, operand: number, result: number, source: number): number {
    if (
      operation < NumericConversion.SignedInteger32ToSignedInteger64 ||
      operation > NumericConversion.ReinterpretSignedInteger32AsFloat32
    ) {
      this.#unsupported = true;
      return result;
    }
    const sourceKind = operation === NumericConversion.SignedInteger32ToSignedInteger64 ||
        operation === NumericConversion.SignedInteger32ToFloat32 ||
        operation === NumericConversion.SignedInteger32ToFloat64 ||
        operation === NumericConversion.ReinterpretSignedInteger32AsFloat32
      ? TermKind.Integer
      : operation === NumericConversion.SignedInteger64ToSignedInteger32 ||
          operation === NumericConversion.SignedInteger64ToFloat32 ||
          operation === NumericConversion.SignedInteger64ToFloat64
      ? TermKind.SignedInteger64
      : operation === NumericConversion.Float32ToSignedInteger32 ||
          operation === NumericConversion.Float32ToSignedInteger64 ||
          operation === NumericConversion.Float32ToFloat64 ||
          operation === NumericConversion.ReinterpretFloat32AsSignedInteger32
      ? TermKind.Float32
      : TermKind.Float64;
    const resultKind = operation === NumericConversion.SignedInteger32ToSignedInteger64 ||
        operation === NumericConversion.Float32ToSignedInteger64 ||
        operation === NumericConversion.Float64ToSignedInteger64
      ? TermKind.SignedInteger64
      : operation === NumericConversion.SignedInteger32ToFloat32 ||
          operation === NumericConversion.SignedInteger64ToFloat32 ||
          operation === NumericConversion.Float64ToFloat32 ||
          operation === NumericConversion.ReinterpretSignedInteger32AsFloat32
      ? TermKind.Float32
      : operation === NumericConversion.SignedInteger32ToFloat64 ||
          operation === NumericConversion.SignedInteger64ToFloat64 ||
          operation === NumericConversion.Float32ToFloat64
      ? TermKind.Float64
      : TermKind.Integer;
    this.#constrain(operand, this.#primitive(sourceKind), source);
    this.#constrain(result, this.#primitive(resultKind), source);
    return result;
  }

  #instantiateConstructor(constructor: number): ConstructorInstance | null {
    const template = this.#constructors[constructor];
    if (template === undefined) return null;
    const parameters = new Map(
      template.parameters.map((parameter) => [parameter, this.#variable()] as const),
    );
    const fields: number[] = [];
    for (const field of template.fields) {
      const type = this.#schema(field, parameters);
      if (type === null) return null;
      fields.push(type);
    }
    let result: number | null;
    if (template.result !== undefined) {
      result = this.#schema(template.result, parameters);
    } else if (template.name === UNIT_CONSTRUCTOR_NAME) {
      result = this.#primitive(TermKind.Unit);
    } else {
      result = this.#term(TermKind.Named, template.declaration);
      for (const parameter of template.parameters) {
        result = this.#term(
          TermKind.Application,
          0,
          result,
          parameters.get(parameter)!,
        );
      }
    }
    if (result === null) return null;
    return {
      fields: Object.freeze(fields),
      result,
      type: fields.reduceRight(
        (remaining, field) => this.#term(TermKind.Function, 0, field, remaining),
        result,
      ),
    };
  }

  #schema(schema: TypeSchema, parameters: ReadonlyMap<string, number> = new Map()): number | null {
    switch (schema.kind) {
      case "integer":
        return this.#primitive(TermKind.Integer);
      case "signed-integer-64":
        return this.#primitive(TermKind.SignedInteger64);
      case "float-32":
        return this.#primitive(TermKind.Float32);
      case "float-64":
        return this.#primitive(TermKind.Float64);
      case "boolean":
        return this.#primitive(TermKind.Boolean);
      case "unit":
        return this.#primitive(TermKind.Unit);
      case "function": {
        const parameter = this.#schema(schema.parameter, parameters);
        const result = this.#schema(schema.result, parameters);
        return parameter === null || result === null
          ? null
          : this.#term(TermKind.Function, 0, parameter, result);
      }
      case "named": {
        const declaration = this.#surface.typeDeclarations.findIndex((candidate) =>
          candidate.name === schema.name
        );
        if (declaration < 0) return null;
        let result = this.#term(TermKind.Named, declaration);
        for (const argument of schema.arguments) {
          const type = this.#schema(argument, parameters);
          if (type === null) return null;
          result = this.#term(TermKind.Application, 0, result, type);
        }
        return result;
      }
      case "parameter":
        return parameters.get(schema.name) ?? null;
      case "forall":
        return null;
    }
  }

  #entryDefinition(): number {
    for (let definition = 0; definition < this.#surface.definitionCount; definition++) {
      const symbol = this.#surface.definitionWords[
        definition * DEFINITION_WORD_LENGTH + DefinitionWord.Symbol
      ];
      if (symbol === this.#surface.entrySymbol) return definition;
    }
    throw new Error(`monomorphic checking omitted entry symbol ${this.#surface.entrySymbol}`);
  }

  #primitive(kind: number): number {
    const existing = this.#primitiveTypes.get(kind);
    if (existing !== undefined) return existing;
    const type = this.#term(kind);
    this.#primitiveTypes.set(kind, type);
    return type;
  }

  #variable(): number {
    return this.#term(TermKind.Variable);
  }

  #term(kind: number, payload = 0, child0 = NO_INDEX, child1 = NO_INDEX): number {
    this.#terms.push({ kind, payload, child0, child1 });
    return this.#terms.length - 1;
  }

  #constrain(left: number, right: number, source: number): void {
    this.#constraints.push({ left, right, source });
  }
}

interface TypeEquationWitness {
  readonly assignments: Uint32Array<ArrayBuffer>;
  readonly types: Uint32Array<ArrayBuffer>;
}

function solveTypeEquations(
  terms: Uint32Array,
  constraints: readonly CheckingConstraint[],
): TypeEquationWitness | null {
  const termCount = terms.length / TERM_WORD_LENGTH;
  const parents = Uint32Array.from({ length: termCount }, (_, term) => term);
  const pending = constraints.map((constraint) => [constraint.left, constraint.right] as const);
  const root = (term: number): number => {
    let current = term;
    while (parents[current] !== current) current = parents[current]!;
    let compressed = term;
    while (parents[compressed] !== compressed) {
      const next = parents[compressed]!;
      parents[compressed] = current;
      compressed = next;
    }
    return current;
  };

  for (let cursor = 0; cursor < pending.length; cursor++) {
    const equation = pending[cursor]!;
    if (equation[0] >= termCount || equation[1] >= termCount) return null;
    const left = root(equation[0]);
    const right = root(equation[1]);
    if (left === right) continue;
    const leftBase = left * TERM_WORD_LENGTH;
    const rightBase = right * TERM_WORD_LENGTH;
    const leftKind = terms[leftBase + 1];
    const rightKind = terms[rightBase + 1];
    if (leftKind === undefined || rightKind === undefined) return null;
    if (leftKind === TermKind.Variable) {
      parents[left] = right;
      continue;
    }
    if (rightKind === TermKind.Variable) {
      parents[right] = left;
      continue;
    }
    if (leftKind !== rightKind || terms[leftBase + 2] !== terms[rightBase + 2]) return null;

    for (const childWord of [3, 4]) {
      const leftChild = terms[leftBase + childWord];
      const rightChild = terms[rightBase + childWord];
      if (leftChild === NO_INDEX && rightChild === NO_INDEX) continue;
      if (
        leftChild === undefined || rightChild === undefined || leftChild === NO_INDEX ||
        rightChild === NO_INDEX
      ) return null;
      pending.push([leftChild, rightChild]);
    }
    const representative = Math.min(left, right);
    parents[Math.max(left, right)] = representative;
  }

  const assignments = new Uint32Array(termCount);
  const witnessWords: number[] = [];
  const typeByShape = new Map<string, number>();
  const materializedByRoot = new Map<number, number>();
  const active = new Set<number>();
  const materialize = (term: number): number | null => {
    const representative = root(term);
    const existing = materializedByRoot.get(representative);
    if (existing !== undefined) return existing;
    if (active.has(representative)) return null;
    active.add(representative);
    const base = representative * TERM_WORD_LENGTH;
    const kind = terms[base + 1];
    const payload = terms[base + 2];
    if (kind === undefined || payload === undefined) return null;
    const children: number[] = [];
    for (const childWord of [3, 4]) {
      const child = terms[base + childWord];
      if (child === undefined) return null;
      if (child === NO_INDEX) {
        children.push(NO_INDEX);
        continue;
      }
      const childType = materialize(child);
      if (childType === null) return null;
      children.push(childType);
    }
    active.delete(representative);
    const key = `${kind}:${payload}:${children[0]}:${children[1]}`;
    let type = typeByShape.get(key);
    if (type === undefined) {
      type = witnessWords.length / WITNESS_TYPE_WORD_LENGTH;
      typeByShape.set(key, type);
      witnessWords.push(kind, payload, children[0]!, children[1]!);
    }
    materializedByRoot.set(representative, type);
    return type;
  };

  for (let term = 0; term < termCount; term++) {
    const type = materialize(term);
    if (type === null) return null;
    assignments[term] = type;
  }
  return { assignments, types: Uint32Array.from(witnessWords) };
}

export function prepareTypedCoreCertificate(
  surface: EncodedSemanticSurface,
  nodes: readonly CoreNode[],
): TypedCoreCertificatePreparation {
  return new TypedCoreCertificatePlanner(surface, nodes).plan();
}

export class GpuTypedCoreChecker {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  private constructor(device: GPUDevice, pipeline: GPUComputePipeline) {
    this.#device = device;
    this.#pipeline = pipeline;
  }

  static async create(device: GPUDevice): Promise<GpuTypedCoreChecker> {
    const shader = device.createShaderModule({
      label: "typed Core certificate checker",
      code: MONOMORPHIC_CHECKER_SHADER,
    });
    const compilation = await shader.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length !== 0) {
      throw new Error(
        `WebGPU rejected the typed Core certificate checker:\n${
          errors.map((error) => `${error.lineNum}:${error.linePos}: ${error.message}`).join("\n")
        }`,
      );
    }
    const pipeline = await device.createComputePipelineAsync({
      label: "typed Core certificate checker",
      layout: "auto",
      compute: { module: shader, entryPoint: "check_certificate" },
    });
    return new GpuTypedCoreChecker(device, pipeline);
  }

  async check(
    plans: readonly TypedCoreCertificatePlan[],
    signal?: AbortSignal,
  ): Promise<readonly boolean[]> {
    if (plans.length === 0) return [];
    signal?.throwIfAborted();
    const packed = packPlans(plans);
    const workgroups = Math.ceil(packed.workCount / WORKGROUP_SIZE);
    const limits = this.#device.limits;
    if (
      packed.input.byteLength > limits.maxBufferSize ||
      packed.input.byteLength > limits.maxStorageBufferBindingSize ||
      packed.state.byteLength > limits.maxBufferSize ||
      packed.state.byteLength > limits.maxStorageBufferBindingSize ||
      workgroups > limits.maxComputeWorkgroupsPerDimension
    ) return plans.map(() => false);
    let inputBuffer: GPUBuffer | undefined;
    let stateBuffer: GPUBuffer | undefined;
    let readbackBuffer: GPUBuffer | undefined;
    let mapped = false;
    try {
      this.#device.pushErrorScope("validation");
      this.#device.pushErrorScope("out-of-memory");
      let operationFailure: { readonly cause: unknown } | undefined;
      try {
        inputBuffer = this.#device.createBuffer({
          label: "typed Core certificate",
          size: packed.input.byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        stateBuffer = this.#device.createBuffer({
          label: "typed Core certificate state",
          size: packed.state.byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        readbackBuffer = this.#device.createBuffer({
          label: "typed Core certificate readback",
          size: packed.state.byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        this.#device.queue.writeBuffer(inputBuffer, 0, packed.input);
        this.#device.queue.writeBuffer(stateBuffer, 0, packed.state);
        const bindings = this.#device.createBindGroup({
          label: "typed Core certificate bindings",
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: inputBuffer } },
            { binding: 1, resource: { buffer: stateBuffer } },
          ],
        });
        const commands = this.#device.createCommandEncoder({
          label: "check typed Core certificate",
        });
        const pass = commands.beginComputePass({ label: "check typed Core certificate" });
        pass.setPipeline(this.#pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(workgroups);
        pass.end();
        commands.copyBufferToBuffer(
          stateBuffer,
          0,
          readbackBuffer,
          0,
          packed.state.byteLength,
        );
        this.#device.queue.submit([commands.finish()]);
      } catch (cause) {
        operationFailure = { cause };
      }
      const [outOfMemory, validation] = await Promise.all([
        this.#device.popErrorScope(),
        this.#device.popErrorScope(),
      ]);
      if (operationFailure !== undefined) throw operationFailure.cause;
      if (outOfMemory !== null || validation !== null) return plans.map(() => false);
      if (readbackBuffer === undefined) {
        throw new Error("monomorphic checking omitted its readback buffer");
      }
      await readbackBuffer.mapAsync(GPUMapMode.READ);
      signal?.throwIfAborted();
      mapped = true;
      const bytes = readbackBuffer.getMappedRange();
      const state = new Uint32Array(bytes, 0, packed.state.length);
      return plans.map((_, planIndex) =>
        state[planIndex * CHECKING_STATE_WORD_LENGTH + 6] === NO_FAILURE
      );
    } finally {
      if (mapped) readbackBuffer?.unmap();
      inputBuffer?.destroy();
      stateBuffer?.destroy();
      readbackBuffer?.destroy();
    }
  }
}

interface PackedPlans {
  readonly input: Uint32Array<ArrayBuffer>;
  readonly state: Uint32Array<ArrayBuffer>;
  readonly workCount: number;
}

function packPlans(plans: readonly TypedCoreCertificatePlan[]): PackedPlans {
  let termCount = 0;
  let witnessTypeCount = 0;
  let constraintCount = 0;
  for (const plan of plans) {
    termCount += plan.terms.length / TERM_WORD_LENGTH;
    witnessTypeCount += plan.witnessTypeCount;
    constraintCount += plan.constraints.length;
  }
  const termWordBase = CHECKING_INPUT_HEADER_WORD_LENGTH;
  const witnessTypeWordBase = termWordBase + termCount * PACKED_TERM_WORD_LENGTH;
  const constraintWordBase = witnessTypeWordBase +
    witnessTypeCount * PACKED_WITNESS_TYPE_WORD_LENGTH;
  const input = new Uint32Array(constraintWordBase + constraintCount * CONSTRAINT_WORD_LENGTH);
  input[0] = termCount;
  input[1] = witnessTypeCount;
  input[2] = constraintCount;
  input[3] = witnessTypeWordBase;
  input[4] = constraintWordBase;
  const state = new Uint32Array(plans.length * CHECKING_STATE_WORD_LENGTH);
  let termCursor = 0;
  let witnessTypeCursor = 0;
  let constraintCursor = 0;
  for (const [planIndex, plan] of plans.entries()) {
    const termBase = termCursor;
    const witnessTypeBase = witnessTypeCursor;
    const localTermCount = plan.terms.length / TERM_WORD_LENGTH;
    const localWitnessTypeCount = plan.witnessTypeCount;
    for (let term = 0; term < localTermCount; term++) {
      const local = term * TERM_WORD_LENGTH;
      const packed = termWordBase + (termBase + term) * PACKED_TERM_WORD_LENGTH;
      input[packed] = plan.terms[local + 1]!;
      input[packed + 1] = plan.terms[local + 2]!;
      const child0 = plan.terms[local + 3]!;
      const child1 = plan.terms[local + 4]!;
      input[packed + 2] = child0 === NO_INDEX ? NO_INDEX : termBase + child0;
      input[packed + 3] = child1 === NO_INDEX ? NO_INDEX : termBase + child1;
      input[packed + 4] = witnessTypeBase + plan.assignments[term]!;
      input[packed + 5] = planIndex;
    }
    for (let type = 0; type < localWitnessTypeCount; type++) {
      const local = type * WITNESS_TYPE_WORD_LENGTH;
      const packed = witnessTypeWordBase +
        (witnessTypeBase + type) * PACKED_WITNESS_TYPE_WORD_LENGTH;
      input[packed] = plan.witnessTypes[local]!;
      input[packed + 1] = plan.witnessTypes[local + 1]!;
      const child0 = plan.witnessTypes[local + 2]!;
      const child1 = plan.witnessTypes[local + 3]!;
      input[packed + 2] = child0 === NO_INDEX ? NO_INDEX : witnessTypeBase + child0;
      input[packed + 3] = child1 === NO_INDEX ? NO_INDEX : witnessTypeBase + child1;
      input[packed + 4] = planIndex;
    }
    const firstConstraint = constraintCursor;
    for (const constraint of plan.constraints) {
      const packed = constraintWordBase + constraintCursor * CONSTRAINT_WORD_LENGTH;
      input[packed] = termBase + constraint.left;
      input[packed + 1] = termBase + constraint.right;
      input[packed + 2] = planIndex;
      constraintCursor++;
    }
    const stateBase = planIndex * CHECKING_STATE_WORD_LENGTH;
    state[stateBase] = termBase;
    state[stateBase + 1] = termBase + localTermCount;
    state[stateBase + 2] = witnessTypeBase;
    state[stateBase + 3] = witnessTypeBase + localWitnessTypeCount;
    state[stateBase + 4] = firstConstraint;
    state[stateBase + 5] = constraintCursor;
    state[stateBase + 6] = NO_FAILURE;
    termCursor += localTermCount;
    witnessTypeCursor += localWitnessTypeCount;
  }
  return {
    input,
    state,
    workCount: Math.max(termCount, witnessTypeCount, constraintCount),
  };
}

const MONOMORPHIC_CHECKER_SHADER = /* wgsl */ `
struct Term {
  kind: u32,
  payload: u32,
  child0: u32,
  child1: u32,
  assignment: u32,
  owner: u32,
}

struct WitnessType {
  kind: u32,
  payload: u32,
  child0: u32,
  child1: u32,
  owner: u32,
}

struct Constraint {
  left: u32,
  right: u32,
  owner: u32,
}

struct CheckingState {
  first_term: u32,
  end_term: u32,
  first_type: u32,
  end_type: u32,
  first_constraint: u32,
  end_constraint: u32,
  first_failure: atomic<u32>,
}

@group(0) @binding(0) var<storage, read> certificate: array<u32>;
@group(0) @binding(1) var<storage, read_write> states: array<CheckingState>;

const VARIABLE: u32 = ${TermKind.Variable}u;
const NO_INDEX: u32 = 0xffffffffu;
const HEADER_WORDS: u32 = ${CHECKING_INPUT_HEADER_WORD_LENGTH}u;
const TERM_WORDS: u32 = ${PACKED_TERM_WORD_LENGTH}u;
const TYPE_WORDS: u32 = ${PACKED_WITNESS_TYPE_WORD_LENGTH}u;
const CONSTRAINT_WORDS: u32 = ${CONSTRAINT_WORD_LENGTH}u;

fn read_term(index: u32) -> Term {
  let base = HEADER_WORDS + index * TERM_WORDS;
  return Term(
    certificate[base], certificate[base + 1u], certificate[base + 2u],
    certificate[base + 3u], certificate[base + 4u], certificate[base + 5u]
  );
}

fn read_witness_type(index: u32) -> WitnessType {
  let base = certificate[3u] + index * TYPE_WORDS;
  return WitnessType(
    certificate[base], certificate[base + 1u], certificate[base + 2u],
    certificate[base + 3u], certificate[base + 4u]
  );
}

fn read_constraint(index: u32) -> Constraint {
  let base = certificate[4u] + index * CONSTRAINT_WORDS;
  return Constraint(certificate[base], certificate[base + 1u], certificate[base + 2u]);
}

fn fail(owner: u32, location: u32) {
  atomicMin(&states[owner].first_failure, location);
}

fn term_child_matches(owner: u32, child: u32, expected: u32) -> bool {
  if child == NO_INDEX || expected == NO_INDEX { return child == expected; }
  if child < states[owner].first_term || child >= states[owner].end_term { return false; }
  let term = read_term(child);
  return term.owner == owner && term.assignment == expected;
}

fn check_term(index: u32) {
  let term = read_term(index);
  if term.owner >= arrayLength(&states) { return; }
  let state = states[term.owner];
  if index < state.first_term || index >= state.end_term ||
    term.assignment < state.first_type || term.assignment >= state.end_type {
    fail(term.owner, index);
    return;
  }
  let witnessed = read_witness_type(term.assignment);
  if witnessed.owner != term.owner { fail(term.owner, index); return; }
  if term.kind == VARIABLE { return; }
  if term.kind != witnessed.kind || term.payload != witnessed.payload ||
    !term_child_matches(term.owner, term.child0, witnessed.child0) ||
    !term_child_matches(term.owner, term.child1, witnessed.child1) {
    fail(term.owner, index);
  }
}

fn check_witness_type(index: u32) {
  let witnessed = read_witness_type(index);
  if witnessed.owner >= arrayLength(&states) { return; }
  let state = states[witnessed.owner];
  if index < state.first_type || index >= state.end_type {
    fail(witnessed.owner, index);
    return;
  }
  if witnessed.child0 != NO_INDEX &&
    (witnessed.child0 < state.first_type || witnessed.child0 >= index) {
    fail(witnessed.owner, index);
    return;
  }
  if witnessed.child1 != NO_INDEX &&
    (witnessed.child1 < state.first_type || witnessed.child1 >= index) {
    fail(witnessed.owner, index);
  }
}

fn check_constraint(index: u32) {
  let constraint = read_constraint(index);
  if constraint.owner >= arrayLength(&states) { return; }
  let state = states[constraint.owner];
  if index < state.first_constraint || index >= state.end_constraint ||
    constraint.left < state.first_term || constraint.left >= state.end_term ||
    constraint.right < state.first_term || constraint.right >= state.end_term {
    fail(constraint.owner, index);
    return;
  }
  let left = read_term(constraint.left);
  let right = read_term(constraint.right);
  if left.owner != constraint.owner || right.owner != constraint.owner ||
    left.assignment != right.assignment {
    fail(constraint.owner, index);
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn check_certificate(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if index < certificate[0u] { check_term(index); }
  if index < certificate[1u] { check_witness_type(index); }
  if index < certificate[2u] { check_constraint(index); }
}
`;
