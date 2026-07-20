import {
  type EncodedLazuliSurface,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_DEFINITION_WORD_LENGTH,
  LAZULI_NO_INDEX,
  LAZULI_NODE_WORD_LENGTH,
  LAZULI_TYPE_WORD_LENGTH,
  LazuliBinaryOperator,
  LazuliConstructorWord,
  LazuliDefinitionWord,
  type LazuliDiagnostic,
  type LazuliSourceType,
  LazuliSurfaceTag,
  LazuliSurfaceWord,
  type LazuliType,
  type LazuliTypeDeclaration,
  type LazuliTypeSchema,
  LazuliTypeWord,
  LazuliUnaryOperator,
} from "./abi.ts";

export interface LazuliTypeInferenceSuccess {
  readonly ok: true;
  readonly mainType: LazuliType;
  readonly typeDeclarations: readonly LazuliTypeDeclaration[];
  /** Indexed by the stable constructor index in `surface.constructorWords`. */
  readonly constructorFieldTypes: readonly (readonly LazuliTypeSchema[])[];
}

export interface LazuliTypeInferenceFailure {
  readonly ok: false;
  readonly diagnostic: LazuliDiagnostic;
}

export type LazuliTypeInferenceResult = LazuliTypeInferenceSuccess | LazuliTypeInferenceFailure;

interface InferenceVariable {
  readonly kind: "variable";
  readonly id: number;
  instance: InferenceType | null;
}

interface RigidVariable {
  readonly kind: "rigid";
  readonly id: number;
  readonly name: string;
  readonly origin: "ambient" | "pattern";
  readonly scope: number;
  refinement: InferenceType | null;
}

interface IntegerType {
  readonly kind: "integer";
}

interface BooleanType {
  readonly kind: "boolean";
}

interface UnitType {
  readonly kind: "unit";
}

interface SignedInteger64Type {
  readonly kind: "signed-integer-64";
}

interface Float32Type {
  readonly kind: "float-32";
}

interface Float64Type {
  readonly kind: "float-64";
}

interface TupleType {
  readonly kind: "tuple";
  readonly values: readonly [InferenceType, InferenceType];
}

interface NamedType {
  readonly kind: "named";
  readonly name: string;
  readonly arguments: readonly InferenceType[];
}

interface FunctionType {
  readonly kind: "function";
  readonly parameter: InferenceType;
  readonly result: InferenceType;
}

type TypeParameter = InferenceVariable | RigidVariable;
type InferenceType =
  | TypeParameter
  | IntegerType
  | BooleanType
  | UnitType
  | SignedInteger64Type
  | Float32Type
  | Float64Type
  | TupleType
  | NamedType
  | FunctionType;

interface TypeScheme {
  readonly parameters: readonly TypeParameter[];
  readonly type: InferenceType;
}

interface ConstructorTyping {
  readonly symbol: number;
  readonly name: string;
  readonly typeIndex: number;
  readonly parameters: readonly TypeParameter[];
  readonly fields: readonly InferenceType[];
  readonly result: InferenceType;
}

interface InstantiatedConstructor {
  readonly fields: readonly InferenceType[];
  readonly result: InferenceType;
}

interface TypeDeclarationShape {
  readonly typeIndex: number;
  readonly name: string;
  readonly arity: number;
  readonly constructors: readonly number[];
  readonly indexed: boolean;
}

interface RigidRefinement {
  readonly source: RigidVariable;
  readonly previous: InferenceType | null;
}

type TypeEnvironment = ReadonlyMap<number, TypeScheme>;

const INTEGER: IntegerType = Object.freeze({ kind: "integer" });
const BOOLEAN: BooleanType = Object.freeze({ kind: "boolean" });
const UNIT: UnitType = Object.freeze({ kind: "unit" });
const SIGNED_INTEGER_64: SignedInteger64Type = Object.freeze({ kind: "signed-integer-64" });
const FLOAT_32: Float32Type = Object.freeze({ kind: "float-32" });
const FLOAT_64: Float64Type = Object.freeze({ kind: "float-64" });

function numericTypeForUnaryOperator(operator: number): InferenceType {
  switch (operator) {
    case 1:
      return INTEGER;
    case 2:
      return SIGNED_INTEGER_64;
    case 3:
      return FLOAT_32;
    case 4:
      return FLOAT_64;
    case 5:
      return FLOAT_32;
    default:
      throw new Error(`Unsupported Lazuli unary operator ${operator}.`);
  }
}

function numericTypeForBinaryOperator(operator: number): InferenceType {
  if (operator >= 1 && operator <= 10) return INTEGER;
  if (operator <= 20) return SIGNED_INTEGER_64;
  if (operator <= 30) return FLOAT_32;
  if (operator <= 40) return FLOAT_64;
  if (operator <= 46) return INTEGER;
  if (operator <= 52) return SIGNED_INTEGER_64;
  throw new Error(`Unsupported Lazuli binary operator ${operator}.`);
}

function binaryOperatorIsComparison(operator: number): boolean {
  return operator <= 40 && (operator - 1) % 10 < 6 ||
    operator >= LazuliBinaryOperator.EqualWholeNumberF64 &&
      operator <= LazuliBinaryOperator.GreaterEqualWholeNumberF64;
}

function numericConversionTypes(operator: number): readonly [InferenceType, InferenceType] {
  switch (operator) {
    case 1:
      return [INTEGER, SIGNED_INTEGER_64];
    case 2:
      return [SIGNED_INTEGER_64, INTEGER];
    case 3:
      return [INTEGER, FLOAT_32];
    case 4:
      return [INTEGER, FLOAT_64];
    case 5:
      return [SIGNED_INTEGER_64, FLOAT_32];
    case 6:
      return [SIGNED_INTEGER_64, FLOAT_64];
    case 7:
      return [FLOAT_32, INTEGER];
    case 8:
      return [FLOAT_32, SIGNED_INTEGER_64];
    case 9:
      return [FLOAT_32, FLOAT_64];
    case 10:
      return [FLOAT_64, INTEGER];
    case 11:
      return [FLOAT_64, SIGNED_INTEGER_64];
    case 12:
      return [FLOAT_64, FLOAT_32];
    case 13:
      return [FLOAT_32, INTEGER];
    case 14:
      return [INTEGER, FLOAT_32];
    default:
      throw new Error(`Unsupported Lazuli numeric conversion ${operator}.`);
  }
}

class InferenceDiagnostic extends Error {
  constructor(readonly diagnostic: LazuliDiagnostic) {
    super(diagnostic.message);
  }
}

class InferenceContext {
  readonly #surface: EncodedLazuliSurface;
  readonly #definitionBySymbol = new Map<number, number>();
  readonly #constructorBySymbol = new Map<number, ConstructorTyping>();
  readonly #typeByName = new Map<string, TypeDeclarationShape>();
  readonly #definitionSchemes = new Map<number, TypeScheme>();
  readonly #constructorFieldTypes: LazuliTypeSchema[][] = [];
  readonly #publicTypeDeclarations: LazuliTypeDeclaration[] = [];
  readonly #refinementTrail: RigidRefinement[] = [];
  #nextTypeVariable = 0;
  #rigidScope = 0;
  #untouchableTypeVariableCutoff: number | null = null;

  constructor(surface: EncodedLazuliSurface) {
    this.#surface = surface;
  }

  infer(): LazuliTypeInferenceSuccess {
    this.validateMetadataCounts();
    this.indexDefinitions();
    this.indexTypeDeclarationShapes();
    this.buildConstructorTypes();

    const components = this.definitionComponents();
    for (const component of components) this.inferDefinitionComponent(component);

    const mainScheme = this.#definitionSchemes.get(this.#surface.mainSymbol);
    if (mainScheme === undefined) {
      throw this.failure("L2104", "main has no inferred type", { startByte: 0, endByte: 0 });
    }
    if (this.containsTypeParameter(mainScheme.type)) {
      throw this.failure(
        "L2104",
        `main must have a concrete type; inferred ${this.formatType(mainScheme.type)}`,
        this.definitionSpan(this.#definitionBySymbol.get(this.#surface.mainSymbol)),
      );
    }

    return Object.freeze({
      ok: true,
      mainType: this.toPublicType(mainScheme.type),
      typeDeclarations: Object.freeze(this.#publicTypeDeclarations),
      constructorFieldTypes: Object.freeze(
        this.#constructorFieldTypes.map((fields) => Object.freeze(fields)),
      ),
    });
  }

  private validateMetadataCounts(): void {
    if (this.#surface.definitionTypes.length !== this.#surface.definitionCount) {
      throw this.invalidTypeMetadata(
        `surface has ${this.#surface.definitionCount} definitions but ${this.#surface.definitionTypes.length} definition type entries`,
        { startByte: 0, endByte: 0 },
      );
    }
    if (this.#surface.typeDeclarations.length !== this.#surface.typeCount) {
      throw this.invalidTypeMetadata(
        `surface has ${this.#surface.typeCount} types but ${this.#surface.typeDeclarations.length} typed declarations`,
        { startByte: 0, endByte: 0 },
      );
    }
  }

  private indexDefinitions(): void {
    for (
      let definitionIndex = 0;
      definitionIndex < this.#surface.definitionCount;
      definitionIndex++
    ) {
      const symbol = this.definitionWord(definitionIndex, LazuliDefinitionWord.Symbol);
      this.#definitionBySymbol.set(symbol, definitionIndex);
    }
  }

  private indexTypeDeclarationShapes(): void {
    for (let typeIndex = 0; typeIndex < this.#surface.typeCount; typeIndex++) {
      const declaration = this.#surface.typeDeclarations[typeIndex];
      if (declaration === undefined) {
        throw new Error(`Lazuli type metadata omitted type ${typeIndex}.`);
      }
      const span = this.typeSpan(typeIndex);
      const encodedSymbol = this.typeWord(typeIndex, LazuliTypeWord.Symbol);
      const encodedName = this.symbolName(encodedSymbol);
      if (declaration.name !== encodedName) {
        throw this.invalidTypeMetadata(
          `typed declaration ${JSON.stringify(declaration.name)} does not match encoded type ${
            JSON.stringify(encodedName)
          }`,
          span,
        );
      }
      if (this.#typeByName.has(declaration.name)) {
        throw this.invalidTypeMetadata(
          `duplicate type name ${JSON.stringify(declaration.name)}`,
          span,
        );
      }
      const parameters = new Set<string>();
      for (const parameter of declaration.parameters) {
        if (parameters.has(parameter)) {
          throw this.invalidTypeMetadata(
            `type ${JSON.stringify(declaration.name)} repeats parameter ${
              JSON.stringify(parameter)
            }`,
            span,
          );
        }
        parameters.add(parameter);
      }
      const firstConstructor = this.typeWord(typeIndex, LazuliTypeWord.FirstConstructor);
      const constructorCount = this.typeWord(typeIndex, LazuliTypeWord.ConstructorCount);
      const constructors = Array.from(
        { length: constructorCount },
        (_, offset) => firstConstructor + offset,
      );
      this.#typeByName.set(declaration.name, {
        typeIndex,
        name: declaration.name,
        arity: declaration.parameters.length,
        constructors,
        indexed: declaration.constructors.some((constructor) => constructor.result !== undefined),
      });
    }
  }

  private buildConstructorTypes(): void {
    for (let typeIndex = 0; typeIndex < this.#surface.typeCount; typeIndex++) {
      const declaration = this.#surface.typeDeclarations[typeIndex];
      if (declaration === undefined) {
        throw new Error(`Lazuli type metadata omitted type ${typeIndex}.`);
      }
      const typeSpan = this.typeSpan(typeIndex);
      const parameterScope = new Map<string, TypeParameter>();
      const parameters = declaration.parameters.map((name) => {
        const parameter = this.rigidVariable(name);
        parameterScope.set(name, parameter);
        return parameter;
      });
      const firstConstructor = this.typeWord(typeIndex, LazuliTypeWord.FirstConstructor);
      const constructorCount = this.typeWord(typeIndex, LazuliTypeWord.ConstructorCount);
      if (declaration.constructors.length !== constructorCount) {
        throw this.invalidTypeMetadata(
          `type ${
            JSON.stringify(declaration.name)
          } has ${constructorCount} encoded constructors but ${declaration.constructors.length} typed constructors`,
          typeSpan,
        );
      }

      const publicConstructors: LazuliTypeDeclaration["constructors"][number][] = [];
      for (let constructorOffset = 0; constructorOffset < constructorCount; constructorOffset++) {
        const constructorIndex = firstConstructor + constructorOffset;
        const constructor = declaration.constructors[constructorOffset];
        if (constructor === undefined) {
          throw new Error(`Lazuli type metadata omitted constructor ${constructorIndex}.`);
        }
        const constructorSpan = this.constructorSpan(constructorIndex);
        const encodedTypeIndex = this.constructorWord(constructorIndex, LazuliConstructorWord.Type);
        const encodedArity = this.constructorWord(constructorIndex, LazuliConstructorWord.Arity);
        const symbol = this.constructorWord(constructorIndex, LazuliConstructorWord.Symbol);
        const encodedName = this.symbolName(symbol);
        if (encodedTypeIndex !== typeIndex || encodedName !== constructor.name) {
          throw this.invalidTypeMetadata(
            `typed constructor ${
              JSON.stringify(constructor.name)
            } does not match encoded constructor ${JSON.stringify(encodedName)}`,
            constructorSpan,
          );
        }
        if (constructor.fields.length !== encodedArity) {
          throw this.invalidTypeMetadata(
            `constructor ${
              JSON.stringify(constructor.name)
            } has ${encodedArity} encoded fields but ${constructor.fields.length} typed fields`,
            constructorSpan,
          );
        }
        const fields = constructor.fields.map((field) =>
          this.typeFromSchema(field.type, parameterScope, "declared", constructorSpan)
        );
        let result: InferenceType;
        if (constructor.result === undefined) {
          result = this.declaredTypeResult(declaration.name, parameters, constructor.name);
        } else {
          const resultSpan = this.sourceSpan(constructor.result, constructorSpan);
          const convertedResult = this.typeFromSchema(
            constructor.result,
            parameterScope,
            "declared",
            constructorSpan,
          );
          if (
            constructor.result.kind !== "named" || constructor.result.name !== declaration.name
          ) {
            const received = constructor.result.kind === "named"
              ? `${
                JSON.stringify(constructor.result.name)
              } with ${constructor.result.arguments.length} arguments`
              : `a ${constructor.result.kind} result`;
            throw this.invalidTypeMetadata(
              `constructor ${JSON.stringify(constructor.name)} result must have head ${
                JSON.stringify(declaration.name)
              } with ${declaration.parameters.length} arguments; received ${received}`,
              resultSpan,
            );
          }

          const resultParameters = new Set<string>();
          const pendingResultTypes: LazuliTypeSchema[] = [...constructor.result.arguments]
            .reverse();
          while (pendingResultTypes.length > 0) {
            const resultType = pendingResultTypes.pop();
            if (resultType === undefined) break;
            switch (resultType.kind) {
              case "parameter":
                resultParameters.add(resultType.name);
                break;
              case "tuple":
                pendingResultTypes.push(resultType.values[1], resultType.values[0]);
                break;
              case "named":
                for (let index = resultType.arguments.length - 1; index >= 0; index--) {
                  const argument = resultType.arguments[index];
                  if (argument !== undefined) pendingResultTypes.push(argument);
                }
                break;
              case "function":
                pendingResultTypes.push(resultType.result, resultType.parameter);
                break;
              case "integer":
              case "boolean":
              case "unit":
                break;
            }
          }
          const fieldParameters = new Map<string, LazuliTypeSchema>();
          const pendingFieldTypes: LazuliTypeSchema[] = constructor.fields
            .map((field) => field.type)
            .reverse();
          while (pendingFieldTypes.length > 0) {
            const fieldType = pendingFieldTypes.pop();
            if (fieldType === undefined) break;
            switch (fieldType.kind) {
              case "parameter":
                if (!fieldParameters.has(fieldType.name)) {
                  fieldParameters.set(fieldType.name, fieldType);
                }
                break;
              case "tuple":
                pendingFieldTypes.push(fieldType.values[1], fieldType.values[0]);
                break;
              case "named":
                for (let index = fieldType.arguments.length - 1; index >= 0; index--) {
                  const argument = fieldType.arguments[index];
                  if (argument !== undefined) pendingFieldTypes.push(argument);
                }
                break;
              case "function":
                pendingFieldTypes.push(fieldType.result, fieldType.parameter);
                break;
              case "integer":
              case "boolean":
              case "unit":
                break;
            }
          }
          for (const [parameterName, parameterSchema] of fieldParameters) {
            if (resultParameters.has(parameterName)) continue;
            throw this.invalidTypeMetadata(
              `constructor ${JSON.stringify(constructor.name)} field parameter ${
                JSON.stringify(parameterName)
              } does not occur in its result`,
              this.sourceSpan(parameterSchema, constructorSpan),
            );
          }
          result = convertedResult;
        }
        const typing: ConstructorTyping = {
          symbol,
          name: constructor.name,
          typeIndex,
          parameters,
          fields,
          result,
        };
        this.#constructorBySymbol.set(symbol, typing);
        this.#constructorFieldTypes[constructorIndex] = constructor.fields.map((field) =>
          this.copySchema(field.type)
        );
        publicConstructors.push(Object.freeze({
          name: constructor.name,
          fields: Object.freeze(
            constructor.fields.map((field) =>
              Object.freeze({ name: field.name, type: this.copySchema(field.type) })
            ),
          ),
          ...(constructor.result === undefined ? {} : {
            result: this.copySchema(constructor.result),
          }),
        }));
      }
      if (!declaration.name.startsWith("$")) {
        this.#publicTypeDeclarations.push(Object.freeze({
          name: declaration.name,
          parameters: Object.freeze([...declaration.parameters]),
          constructors: Object.freeze(publicConstructors),
        }));
      }
    }
  }

  private declaredTypeResult(
    typeName: string,
    parameters: readonly InferenceType[],
    constructorName: string,
  ): InferenceType {
    if (constructorName === "$Unit") return UNIT;
    if (constructorName === "$Tuple") {
      if (parameters.length !== 2 || parameters[0] === undefined || parameters[1] === undefined) {
        throw this.invalidTypeMetadata(
          "the built-in tuple type must declare exactly two parameters",
          { startByte: 0, endByte: 0 },
        );
      }
      return { kind: "tuple", values: [parameters[0], parameters[1]] };
    }
    return { kind: "named", name: typeName, arguments: parameters };
  }

  private definitionComponents(): readonly (readonly number[])[] {
    const dependencies = new Map<number, ReadonlySet<number>>();
    for (
      let definitionIndex = 0;
      definitionIndex < this.#surface.definitionCount;
      definitionIndex++
    ) {
      const rootNode = this.definitionWord(definitionIndex, LazuliDefinitionWord.RootNode);
      dependencies.set(definitionIndex, this.definitionDependencies(rootNode));
    }

    let nextIndex = 0;
    const indexes = new Map<number, number>();
    const lowLinks = new Map<number, number>();
    const stack: number[] = [];
    const onStack = new Set<number>();
    const components: number[][] = [];

    const visit = (definitionIndex: number): void => {
      const index = nextIndex++;
      indexes.set(definitionIndex, index);
      lowLinks.set(definitionIndex, index);
      stack.push(definitionIndex);
      onStack.add(definitionIndex);

      for (const dependency of dependencies.get(definitionIndex) ?? []) {
        if (!indexes.has(dependency)) {
          visit(dependency);
          lowLinks.set(
            definitionIndex,
            Math.min(
              this.requiredMapValue(lowLinks, definitionIndex),
              this.requiredMapValue(lowLinks, dependency),
            ),
          );
        } else if (onStack.has(dependency)) {
          lowLinks.set(
            definitionIndex,
            Math.min(
              this.requiredMapValue(lowLinks, definitionIndex),
              this.requiredMapValue(indexes, dependency),
            ),
          );
        }
      }

      if (
        this.requiredMapValue(lowLinks, definitionIndex) !==
          this.requiredMapValue(indexes, definitionIndex)
      ) return;
      const component: number[] = [];
      while (stack.length > 0) {
        const member = stack.pop();
        if (member === undefined) throw new Error("Lazuli SCC stack ended unexpectedly.");
        onStack.delete(member);
        component.push(member);
        if (member === definitionIndex) break;
      }
      components.push(component);
    };

    for (
      let definitionIndex = 0;
      definitionIndex < this.#surface.definitionCount;
      definitionIndex++
    ) {
      if (!indexes.has(definitionIndex)) visit(definitionIndex);
    }
    return components;
  }

  private definitionDependencies(rootNode: number): ReadonlySet<number> {
    const dependencies = new Set<number>();
    const visit = (nodeIndex: number, boundSymbols: ReadonlySet<number>): void => {
      const tag = this.nodeWord(nodeIndex, LazuliSurfaceWord.Tag);
      const payload = this.nodeWord(nodeIndex, LazuliSurfaceWord.Payload);
      switch (tag) {
        case LazuliSurfaceTag.Integer:
        case LazuliSurfaceTag.SignedInteger64:
        case LazuliSurfaceTag.Float32:
        case LazuliSurfaceTag.Float64:
        case LazuliSurfaceTag.WholeNumberF64:
        case LazuliSurfaceTag.Boolean:
        case LazuliSurfaceTag.Text:
        case LazuliSurfaceTag.Bytes:
        case LazuliSurfaceTag.RuntimeFault:
          return;
        case LazuliSurfaceTag.Name: {
          if (boundSymbols.has(payload)) return;
          const dependency = this.#definitionBySymbol.get(payload);
          if (dependency !== undefined) dependencies.add(dependency);
          return;
        }
        case LazuliSurfaceTag.Let:
        case LazuliSurfaceTag.StrictLet: {
          visit(this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0), boundSymbols);
          visit(
            this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1),
            this.withBoundSymbol(boundSymbols, payload),
          );
          return;
        }
        case LazuliSurfaceTag.LetRec: {
          const recursiveScope = this.withBoundSymbol(boundSymbols, payload);
          visit(this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0), recursiveScope);
          visit(this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1), recursiveScope);
          return;
        }
        case LazuliSurfaceTag.Lambda:
          visit(
            this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
            this.withBoundSymbol(boundSymbols, payload),
          );
          return;
        case LazuliSurfaceTag.If:
          visit(this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0), boundSymbols);
          visit(this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1), boundSymbols);
          visit(this.requiredChild(nodeIndex, LazuliSurfaceWord.Child2), boundSymbols);
          return;
        case LazuliSurfaceTag.Apply:
        case LazuliSurfaceTag.StrictApply:
        case LazuliSurfaceTag.Binary:
        case LazuliSurfaceTag.BufferAppend:
          visit(this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0), boundSymbols);
          visit(this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1), boundSymbols);
          return;
        case LazuliSurfaceTag.Unary:
        case LazuliSurfaceTag.NumericConvert:
          visit(this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0), boundSymbols);
          return;
        case LazuliSurfaceTag.Case: {
          visit(this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0), boundSymbols);
          let armIndex = this.nodeWord(nodeIndex, LazuliSurfaceWord.Child1);
          while (armIndex !== LAZULI_NO_INDEX) {
            const arm = this.caseArmBody(armIndex);
            let armScope = boundSymbols;
            for (const binder of arm.binders) {
              armScope = this.withBoundSymbol(armScope, binder.symbol);
            }
            visit(arm.body, armScope);
            armIndex = this.nodeWord(armIndex, LazuliSurfaceWord.Child1);
          }
          return;
        }
        default:
          throw new Error(`Unsupported Lazuli surface tag ${tag} at node ${nodeIndex}.`);
      }
    };
    visit(rootNode, new Set());
    return dependencies;
  }

  private inferDefinitionComponent(component: readonly number[]): void {
    const outerEnvironment = this.globalEnvironment();
    const componentEnvironment = new Map(outerEnvironment);
    const placeholders = new Map<number, InferenceVariable>();

    for (const definitionIndex of component) {
      const symbol = this.definitionWord(definitionIndex, LazuliDefinitionWord.Symbol);
      const placeholder = this.inferenceVariable();
      placeholders.set(definitionIndex, placeholder);
      componentEnvironment.set(symbol, { parameters: [], type: placeholder });
    }

    for (const definitionIndex of component) {
      const annotation = this.#surface.definitionTypes[definitionIndex]?.annotation;
      if (annotation === null || annotation === undefined) continue;
      const annotationParameters = new Map<string, TypeParameter>();
      const annotationType = this.typeFromSchema(
        annotation,
        annotationParameters,
        "implicit",
        this.definitionSpan(definitionIndex),
      );
      this.unify(
        this.requiredMapValue(placeholders, definitionIndex),
        annotationType,
        this.sourceSpan(annotation, this.definitionSpan(definitionIndex)),
      );
    }

    for (const definitionIndex of component) {
      const rootNode = this.definitionWord(definitionIndex, LazuliDefinitionWord.RootNode);
      const placeholder = this.requiredMapValue(placeholders, definitionIndex);
      const inferred = this.inferNode(rootNode, componentEnvironment, placeholder);
      this.unify(placeholder, inferred, this.nodeSpan(rootNode));
    }

    for (const definitionIndex of component) {
      const symbol = this.definitionWord(definitionIndex, LazuliDefinitionWord.Symbol);
      const scheme = this.generalize(
        this.requiredMapValue(placeholders, definitionIndex),
        outerEnvironment,
      );
      this.#definitionSchemes.set(symbol, scheme);
    }
  }

  private inferNode(
    nodeIndex: number,
    environment: TypeEnvironment,
    expected: InferenceType | null = null,
  ): InferenceType {
    const tag = this.nodeWord(nodeIndex, LazuliSurfaceWord.Tag);
    const payload = this.nodeWord(nodeIndex, LazuliSurfaceWord.Payload);
    const span = this.nodeSpan(nodeIndex);
    switch (tag) {
      case LazuliSurfaceTag.Integer:
        return INTEGER;
      case LazuliSurfaceTag.SignedInteger64:
        return SIGNED_INTEGER_64;
      case LazuliSurfaceTag.Float32:
        return FLOAT_32;
      case LazuliSurfaceTag.Float64:
        return FLOAT_64;
      case LazuliSurfaceTag.WholeNumberF64:
        return this.namedNodeType(nodeIndex, LazuliSurfaceWord.Child1, span);
      case LazuliSurfaceTag.Text:
      case LazuliSurfaceTag.Bytes: {
        const declaration = this.#surface.typeDeclarations[
          this.nodeWord(nodeIndex, LazuliSurfaceWord.Child0)
        ];
        if (declaration === undefined) {
          throw this.invalidTypeMetadata("literal references unknown type", span);
        }
        return { kind: "named", name: declaration.name, arguments: [] };
      }
      case LazuliSurfaceTag.RuntimeFault:
        return this.inferenceVariable();
      case LazuliSurfaceTag.Boolean:
        return BOOLEAN;
      case LazuliSurfaceTag.Name: {
        const scheme = environment.get(payload);
        if (scheme === undefined) {
          throw this.invalidTypeMetadata(
            `cannot infer unknown name ${this.symbolName(payload)}`,
            span,
          );
        }
        return this.instantiateScheme(scheme);
      }
      case LazuliSurfaceTag.Let:
      case LazuliSurfaceTag.StrictLet: {
        const value = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
          environment,
        );
        const scheme = this.generalize(value, environment);
        const bodyEnvironment = new Map(environment);
        bodyEnvironment.set(payload, scheme);
        return this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1),
          bodyEnvironment,
          expected,
        );
      }
      case LazuliSurfaceTag.LetRec: {
        const recursiveType = this.inferenceVariable();
        const recursiveEnvironment = new Map(environment);
        recursiveEnvironment.set(payload, { parameters: [], type: recursiveType });
        const value = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
          recursiveEnvironment,
          recursiveType,
        );
        this.unify(recursiveType, value, span);
        const bodyEnvironment = new Map(environment);
        bodyEnvironment.set(payload, this.generalize(recursiveType, environment));
        return this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1),
          bodyEnvironment,
          expected,
        );
      }
      case LazuliSurfaceTag.If: {
        const condition = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
          environment,
          BOOLEAN,
        );
        this.unify(BOOLEAN, condition, span);
        const consequentNode = this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1);
        const alternateNode = this.requiredChild(nodeIndex, LazuliSurfaceWord.Child2);
        const inferAlternateFirst =
          this.nodeWord(consequentNode, LazuliSurfaceWord.Tag) === LazuliSurfaceTag.Case &&
          this.nodeWord(alternateNode, LazuliSurfaceWord.Tag) !== LazuliSurfaceTag.Case;
        const firstNode = inferAlternateFirst ? alternateNode : consequentNode;
        const secondNode = inferAlternateFirst ? consequentNode : alternateNode;
        const first = this.inferNode(firstNode, environment, expected);
        if (expected !== null) this.unify(expected, first, this.nodeSpan(firstNode));
        const result = expected ?? first;
        const second = this.inferNode(secondNode, environment, result);
        this.unify(result, second, this.nodeSpan(secondNode));
        return result;
      }
      case LazuliSurfaceTag.Lambda: {
        let expectedFunction = expected === null ? null : this.prune(expected);
        if (expectedFunction?.kind === "variable") {
          const parameter = this.inferenceVariable();
          const result = this.inferenceVariable();
          const functionType: FunctionType = { kind: "function", parameter, result };
          this.unify(expectedFunction, functionType, span);
          expectedFunction = functionType;
        }
        const parameter = expectedFunction?.kind === "function"
          ? expectedFunction.parameter
          : this.inferenceVariable();
        const bodyEnvironment = new Map(environment);
        bodyEnvironment.set(payload, { parameters: [], type: parameter });
        const body = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
          bodyEnvironment,
          expectedFunction?.kind === "function" ? expectedFunction.result : null,
        );
        return { kind: "function", parameter, result: body };
      }
      case LazuliSurfaceTag.Apply:
      case LazuliSurfaceTag.StrictApply: {
        const callee = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
          environment,
        );
        const argument = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1),
          environment,
        );
        const result = expected ?? this.inferenceVariable();
        this.unify(callee, { kind: "function", parameter: argument, result }, span);
        return result;
      }
      case LazuliSurfaceTag.Unary: {
        if (payload === LazuliUnaryOperator.NegateWholeNumberF64) {
          const operandType = this.namedNodeType(nodeIndex, LazuliSurfaceWord.Child1, span);
          const body = this.inferNode(
            this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
            environment,
            operandType,
          );
          this.unify(operandType, body, span);
          return operandType;
        }
        const operandType = numericTypeForUnaryOperator(payload);
        const body = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
          environment,
          operandType,
        );
        this.unify(operandType, body, span);
        return operandType;
      }
      case LazuliSurfaceTag.Binary: {
        if (
          payload === LazuliBinaryOperator.StructuralEqual ||
          payload === LazuliBinaryOperator.StructuralNotEqual
        ) {
          const left = this.inferNode(
            this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
            environment,
          );
          const right = this.inferNode(
            this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1),
            environment,
            left,
          );
          this.unify(left, right, span);
          return BOOLEAN;
        }
        if (
          payload >= LazuliBinaryOperator.EqualWholeNumberF64 &&
          payload <= LazuliBinaryOperator.RemainderWholeNumberF64
        ) {
          const operandType = this.namedNodeType(nodeIndex, LazuliSurfaceWord.Child2, span);
          const left = this.inferNode(
            this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
            environment,
            operandType,
          );
          const right = this.inferNode(
            this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1),
            environment,
            operandType,
          );
          this.unify(operandType, left, span);
          this.unify(operandType, right, span);
          return binaryOperatorIsComparison(payload) ? BOOLEAN : operandType;
        }
        const operandType = numericTypeForBinaryOperator(payload);
        const left = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
          environment,
          operandType,
        );
        const right = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1),
          environment,
          operandType,
        );
        this.unify(operandType, left, span);
        this.unify(operandType, right, span);
        return binaryOperatorIsComparison(payload) ? BOOLEAN : operandType;
      }
      case LazuliSurfaceTag.BufferAppend: {
        const operandType = this.namedNodeType(nodeIndex, LazuliSurfaceWord.Child2, span);
        const left = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
          environment,
          operandType,
        );
        const right = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child1),
          environment,
          operandType,
        );
        this.unify(operandType, left, span);
        this.unify(operandType, right, span);
        return operandType;
      }
      case LazuliSurfaceTag.NumericConvert: {
        const [source, result] = numericConversionTypes(payload);
        const value = this.inferNode(
          this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
          environment,
          source,
        );
        this.unify(source, value, span);
        return result;
      }
      case LazuliSurfaceTag.Case:
        return this.inferCase(nodeIndex, environment, expected);
      default:
        throw new Error(`Unsupported Lazuli expression tag ${tag} at node ${nodeIndex}.`);
    }
  }

  private namedNodeType(
    nodeIndex: number,
    word: 4 | 5 | 6,
    span: LazuliDiagnostic["span"],
  ): InferenceType {
    const declaration = this.#surface.typeDeclarations[this.nodeWord(nodeIndex, word)];
    if (declaration === undefined) {
      throw this.invalidTypeMetadata("expression references unknown named type", span);
    }
    return { kind: "named", name: declaration.name, arguments: [] };
  }

  private inferCase(
    nodeIndex: number,
    environment: TypeEnvironment,
    expected: InferenceType | null,
  ): InferenceType {
    const span = this.nodeSpan(nodeIndex);
    const scrutinee = this.inferNode(
      this.requiredChild(nodeIndex, LazuliSurfaceWord.Child0),
      environment,
    );
    const indexedShape = this.indexedCaseShape(nodeIndex, scrutinee);
    if (indexedShape !== null) {
      return this.inferIndexedCase(nodeIndex, environment, scrutinee, expected, indexedShape);
    }
    return this.inferOrdinaryCase(nodeIndex, environment, scrutinee, span);
  }

  private inferOrdinaryCase(
    nodeIndex: number,
    environment: TypeEnvironment,
    scrutinee: InferenceType,
    span: LazuliDiagnostic["span"],
  ): InferenceType {
    const result = this.inferenceVariable();
    const matchedConstructors = new Set<number>();
    let matchedTypeIndex: number | null = null;
    let armIndex = this.nodeWord(nodeIndex, LazuliSurfaceWord.Child1);
    if (armIndex === LAZULI_NO_INDEX) {
      const scrutineeType = this.prune(scrutinee);
      const shape = scrutineeType.kind === "named"
        ? this.#typeByName.get(scrutineeType.name)
        : undefined;
      if (shape !== undefined && shape.constructors.length === 0) return result;
      const firstConstructor = shape?.constructors[0];
      if (firstConstructor !== undefined) {
        const symbol = this.constructorWord(firstConstructor, LazuliConstructorWord.Symbol);
        throw this.failure(
          "L2010",
          `non-exhaustive case; missing constructor ${JSON.stringify(this.symbolName(symbol))}`,
          span,
        );
      }
      throw this.invalidTypeMetadata(
        `empty case requires a zero-constructor named type; received ${
          this.formatType(scrutineeType)
        }`,
        span,
      );
    }
    while (armIndex !== LAZULI_NO_INDEX) {
      const constructorSymbol = this.nodeWord(armIndex, LazuliSurfaceWord.Payload);
      const constructor = this.#constructorBySymbol.get(constructorSymbol);
      if (constructor === undefined) {
        throw this.invalidTypeMetadata(
          `cannot infer unknown case constructor ${this.symbolName(constructorSymbol)}`,
          this.nodeSpan(armIndex),
        );
      }
      const instantiated = this.instantiateConstructor(constructor);
      this.unify(scrutinee, instantiated.result, this.nodeSpan(armIndex));
      const arm = this.caseArmBody(armIndex);
      if (arm.binders.length !== instantiated.fields.length) {
        throw this.invalidTypeMetadata(
          `constructor ${
            JSON.stringify(constructor.name)
          } has ${instantiated.fields.length} fields but the arm binds ${arm.binders.length}`,
          this.nodeSpan(armIndex),
        );
      }
      const armEnvironment = new Map(environment);
      for (let binderIndex = 0; binderIndex < arm.binders.length; binderIndex++) {
        const binder = arm.binders[binderIndex];
        const field = instantiated.fields[binderIndex];
        if (binder === undefined || field === undefined) {
          throw new Error(`Lazuli case arm ${armIndex} omitted binder ${binderIndex}.`);
        }
        armEnvironment.set(binder.symbol, { parameters: [], type: field });
      }
      const body = this.inferNode(arm.body, armEnvironment);
      this.unify(result, body, this.nodeSpan(armIndex));
      matchedConstructors.add(constructorSymbol);
      matchedTypeIndex ??= constructor.typeIndex;
      armIndex = this.nodeWord(armIndex, LazuliSurfaceWord.Child1);
    }

    if (matchedTypeIndex !== null) {
      const typeDeclaration = this.#surface.typeDeclarations[matchedTypeIndex];
      const shape = typeDeclaration === undefined
        ? undefined
        : this.#typeByName.get(typeDeclaration.name);
      if (shape === undefined) {
        throw new Error(`Lazuli case refers to missing type ${matchedTypeIndex}.`);
      }
      for (const constructorIndex of shape.constructors) {
        const symbol = this.constructorWord(constructorIndex, LazuliConstructorWord.Symbol);
        if (matchedConstructors.has(symbol)) continue;
        throw this.failure(
          "L2010",
          `non-exhaustive case; missing constructor ${JSON.stringify(this.symbolName(symbol))}`,
          span,
        );
      }
    }
    return result;
  }

  private indexedCaseShape(
    nodeIndex: number,
    scrutinee: InferenceType,
  ): TypeDeclarationShape | null {
    const scrutineeType = this.prune(scrutinee);
    if (scrutineeType.kind === "named") {
      const shape = this.#typeByName.get(scrutineeType.name);
      if (shape?.indexed === true) return shape;
    }
    let armIndex = this.nodeWord(nodeIndex, LazuliSurfaceWord.Child1);
    while (armIndex !== LAZULI_NO_INDEX) {
      const constructor = this.#constructorBySymbol.get(
        this.nodeWord(armIndex, LazuliSurfaceWord.Payload),
      );
      const declaration = constructor === undefined
        ? undefined
        : this.#surface.typeDeclarations[constructor.typeIndex];
      const shape = declaration === undefined ? undefined : this.#typeByName.get(declaration.name);
      if (shape?.indexed === true) return shape;
      armIndex = this.nodeWord(armIndex, LazuliSurfaceWord.Child1);
    }
    return null;
  }

  private inferIndexedCase(
    nodeIndex: number,
    environment: TypeEnvironment,
    scrutinee: InferenceType,
    expected: InferenceType | null,
    shape: TypeDeclarationShape,
  ): InferenceType {
    const span = this.nodeSpan(nodeIndex);
    let inferredResult = expected;
    let deferredExpected: InferenceType | null = null;
    if (inferredResult !== null && this.firstInferenceVariable(inferredResult) !== null) {
      deferredExpected = inferredResult;
      inferredResult = null;
    }
    let scrutineeType = this.prune(scrutinee);
    if (scrutineeType.kind === "variable") {
      const declaration = this.#surface.typeDeclarations[shape.typeIndex];
      if (declaration === undefined) {
        throw new Error(`Lazuli indexed case refers to missing type ${shape.typeIndex}.`);
      }
      const shapedScrutinee: NamedType = {
        kind: "named",
        name: shape.name,
        arguments: declaration.parameters.map((name) => this.rigidVariable(name)),
      };
      this.unify(scrutineeType, shapedScrutinee, span);
      scrutineeType = shapedScrutinee;
    } else {
      this.rigidifyInferenceVariables(scrutineeType, shape);
      scrutineeType = this.prune(scrutineeType);
    }
    const unresolvedScrutinee = this.firstInferenceVariable(scrutinee);
    if (unresolvedScrutinee !== null) {
      throw this.invalidTypeMetadata(
        `indexed case for ${
          JSON.stringify(shape.name)
        } requires a fully zonked scrutinee; received ${
          this.formatType(scrutinee)
        } with unsolved inference variable ${this.formatType(unresolvedScrutinee)}`,
        span,
      );
    }
    if (scrutineeType.kind !== "named" || scrutineeType.name !== shape.name) {
      throw this.invalidTypeMetadata(
        `indexed case requires scrutinee ${JSON.stringify(shape.name)}; received ${
          this.formatType(scrutineeType)
        }`,
        span,
      );
    }

    const matchedConstructors = new Set<number>();
    let armIndex = this.nodeWord(nodeIndex, LazuliSurfaceWord.Child1);
    while (armIndex !== LAZULI_NO_INDEX) {
      const constructorSymbol = this.nodeWord(armIndex, LazuliSurfaceWord.Payload);
      const constructor = this.#constructorBySymbol.get(constructorSymbol);
      if (constructor === undefined) {
        throw this.invalidTypeMetadata(
          `cannot infer unknown case constructor ${this.symbolName(constructorSymbol)}`,
          this.nodeSpan(armIndex),
        );
      }
      const checkpoint = this.#refinementTrail.length;
      const previousRigidScope = this.#rigidScope;
      const previousCutoff = this.#untouchableTypeVariableCutoff;
      this.#rigidScope += 1;
      const cutoff = this.#nextTypeVariable;
      this.#untouchableTypeVariableCutoff = cutoff;
      try {
        const instantiated = this.instantiatePatternConstructor(constructor);
        const constructorResult = this.formatType(instantiated.result);
        const scrutineeDescription = this.formatType(scrutineeType);
        if (
          constructor.typeIndex !== shape.typeIndex ||
          !this.matchPatternType(instantiated.result, scrutineeType)
        ) {
          throw this.failure(
            "L2102",
            `constructor ${
              JSON.stringify(constructor.name)
            } is inaccessible: result ${constructorResult} is incompatible with scrutinee ${scrutineeDescription}`,
            this.nodeSpan(armIndex),
          );
        }
        const arm = this.caseArmBody(armIndex);
        if (arm.binders.length !== instantiated.fields.length) {
          throw this.invalidTypeMetadata(
            `constructor ${
              JSON.stringify(constructor.name)
            } has ${instantiated.fields.length} fields but the arm binds ${arm.binders.length}`,
            this.nodeSpan(armIndex),
          );
        }
        const armEnvironment = new Map(environment);
        for (let binderIndex = 0; binderIndex < arm.binders.length; binderIndex++) {
          const binder = arm.binders[binderIndex];
          const field = instantiated.fields[binderIndex];
          if (binder === undefined || field === undefined) {
            throw new Error(`Lazuli case arm ${armIndex} omitted binder ${binderIndex}.`);
          }
          armEnvironment.set(binder.symbol, { parameters: [], type: field });
        }
        const body = this.inferNode(
          arm.body,
          armEnvironment,
          inferredResult ?? deferredExpected,
        );
        if (inferredResult === null) {
          const matchesDeferred = deferredExpected !== null &&
            this.prune(body) === this.prune(deferredExpected);
          if (!matchesDeferred && !this.isStableConcrete(body)) {
            throw this.invalidTypeMetadata(
              `indexed case for ${
                JSON.stringify(shape.name)
              } requires a propagated expected type; received no expected type`,
              span,
            );
          }
          inferredResult = matchesDeferred ? deferredExpected : body;
        } else {
          this.unify(inferredResult, body, this.nodeSpan(armIndex));
        }
        matchedConstructors.add(constructorSymbol);
      } finally {
        this.rollbackRefinements(checkpoint);
        this.#rigidScope = previousRigidScope;
        this.#untouchableTypeVariableCutoff = previousCutoff;
      }
      if (deferredExpected !== null && inferredResult !== null) {
        this.unify(deferredExpected, inferredResult, this.nodeSpan(armIndex));
        deferredExpected = null;
      }
      armIndex = this.nodeWord(armIndex, LazuliSurfaceWord.Child1);
    }

    for (const constructorIndex of shape.constructors) {
      const constructorSymbol = this.constructorWord(
        constructorIndex,
        LazuliConstructorWord.Symbol,
      );
      const constructor = this.#constructorBySymbol.get(constructorSymbol);
      if (constructor === undefined) {
        throw new Error(
          `Lazuli indexed type ${shape.name} omitted constructor ${constructorIndex}.`,
        );
      }
      const checkpoint = this.#refinementTrail.length;
      const previousRigidScope = this.#rigidScope;
      this.#rigidScope += 1;
      let compatible = false;
      try {
        compatible = this.matchPatternType(
          this.instantiatePatternConstructor(constructor).result,
          scrutineeType,
        );
      } finally {
        this.rollbackRefinements(checkpoint);
        this.#rigidScope = previousRigidScope;
      }
      if (!compatible || matchedConstructors.has(constructorSymbol)) continue;
      throw this.failure(
        "L2010",
        `non-exhaustive case; missing constructor ${
          JSON.stringify(this.symbolName(constructorSymbol))
        }`,
        span,
      );
    }
    if (inferredResult === null) {
      throw new Error(`Lazuli indexed case ${nodeIndex} did not infer a result type.`);
    }
    return inferredResult;
  }

  private rigidifyInferenceVariables(type: InferenceType, shape: TypeDeclarationShape): void {
    const declaration = this.#surface.typeDeclarations[shape.typeIndex];
    const fallbackName = declaration?.parameters[0] ?? "inferred";
    const pending = [type];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const pruned = this.prune(current);
      if (pruned.kind === "variable") {
        this.unify(pruned, this.rigidVariable(fallbackName), { startByte: 0, endByte: 0 });
        continue;
      }
      if (pruned.kind === "tuple") {
        pending.push(pruned.values[1], pruned.values[0]);
      } else if (pruned.kind === "named") {
        for (let index = pruned.arguments.length - 1; index >= 0; index--) {
          const argument = pruned.arguments[index];
          if (argument !== undefined) pending.push(argument);
        }
      } else if (pruned.kind === "function") {
        pending.push(pruned.result, pruned.parameter);
      }
    }
  }

  private isStableConcrete(type: InferenceType): boolean {
    if (type.kind === "variable") {
      return type.instance !== null && this.isStableConcrete(type.instance);
    }
    if (type.kind === "rigid") return false;
    if (type.kind === "tuple") {
      return this.isStableConcrete(type.values[0]) && this.isStableConcrete(type.values[1]);
    }
    if (type.kind === "named") {
      return type.arguments.every((argument) => this.isStableConcrete(argument));
    }
    if (type.kind === "function") {
      return this.isStableConcrete(type.parameter) && this.isStableConcrete(type.result);
    }
    return true;
  }

  private globalEnvironment(): Map<number, TypeScheme> {
    const environment = new Map(this.#definitionSchemes);
    for (const constructor of this.#constructorBySymbol.values()) {
      environment.set(constructor.symbol, {
        parameters: constructor.parameters,
        type: this.constructorFunctionType(constructor.fields, constructor.result),
      });
    }
    return environment;
  }

  private constructorFunctionType(
    fields: readonly InferenceType[],
    result: InferenceType,
  ): InferenceType {
    let type = result;
    for (let fieldIndex = fields.length - 1; fieldIndex >= 0; fieldIndex--) {
      const field = fields[fieldIndex];
      if (field === undefined) throw new Error(`Constructor omitted field ${fieldIndex}.`);
      type = { kind: "function", parameter: field, result: type };
    }
    return type;
  }

  private instantiateConstructor(constructor: ConstructorTyping): InstantiatedConstructor {
    const replacements = new Map<TypeParameter, InferenceVariable>();
    for (const parameter of constructor.parameters) {
      replacements.set(parameter, this.inferenceVariable());
    }
    return {
      fields: constructor.fields.map((field) => this.replaceParameters(field, replacements)),
      result: this.replaceParameters(constructor.result, replacements),
    };
  }

  private instantiatePatternConstructor(constructor: ConstructorTyping): InstantiatedConstructor {
    const replacements = new Map<TypeParameter, RigidVariable>();
    for (const parameter of constructor.parameters) {
      const name = parameter.kind === "rigid"
        ? parameter.name
        : this.typeVariableName(parameter.id);
      replacements.set(parameter, this.rigidVariable(name, "pattern", this.#rigidScope));
    }
    return {
      fields: constructor.fields.map((field) => this.replaceParameters(field, replacements)),
      result: this.replaceParameters(constructor.result, replacements),
    };
  }

  private instantiateScheme(scheme: TypeScheme): InferenceType {
    const replacements = new Map<TypeParameter, InferenceVariable>();
    for (const parameter of scheme.parameters) {
      replacements.set(parameter, this.inferenceVariable());
    }
    return this.replaceParameters(scheme.type, replacements);
  }

  private replaceParameters(
    type: InferenceType,
    replacements: ReadonlyMap<TypeParameter, TypeParameter>,
  ): InferenceType {
    const pruned = this.prune(type);
    if (pruned.kind === "variable" || pruned.kind === "rigid") {
      return replacements.get(pruned) ?? pruned;
    }
    switch (pruned.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return pruned;
      case "tuple":
        return {
          kind: "tuple",
          values: [
            this.replaceParameters(pruned.values[0], replacements),
            this.replaceParameters(pruned.values[1], replacements),
          ],
        };
      case "named":
        return {
          kind: "named",
          name: pruned.name,
          arguments: pruned.arguments.map((argument) =>
            this.replaceParameters(argument, replacements)
          ),
        };
      case "function":
        return {
          kind: "function",
          parameter: this.replaceParameters(pruned.parameter, replacements),
          result: this.replaceParameters(pruned.result, replacements),
        };
    }
  }

  private generalize(type: InferenceType, environment: TypeEnvironment): TypeScheme {
    const parameters = this.freeTypeParameters(type);
    const environmentParameters = this.freeEnvironmentParameters(environment);
    return {
      parameters: [...parameters].filter((parameter) =>
        !environmentParameters.has(parameter) &&
        (parameter.kind !== "rigid" || parameter.origin !== "pattern")
      ),
      type,
    };
  }

  private freeEnvironmentParameters(environment: TypeEnvironment): Set<TypeParameter> {
    const result = new Set<TypeParameter>();
    for (const scheme of environment.values()) {
      const quantified = new Set(scheme.parameters);
      for (const parameter of this.freeTypeParameters(scheme.type)) {
        if (!quantified.has(parameter)) result.add(parameter);
      }
    }
    return result;
  }

  private freeTypeParameters(
    type: InferenceType,
    result = new Set<TypeParameter>(),
  ): Set<TypeParameter> {
    const pruned = this.prune(type);
    switch (pruned.kind) {
      case "variable":
      case "rigid":
        result.add(pruned);
        break;
      case "tuple":
        this.freeTypeParameters(pruned.values[0], result);
        this.freeTypeParameters(pruned.values[1], result);
        break;
      case "named":
        for (const argument of pruned.arguments) this.freeTypeParameters(argument, result);
        break;
      case "function":
        this.freeTypeParameters(pruned.parameter, result);
        this.freeTypeParameters(pruned.result, result);
        break;
      case "integer":
      case "boolean":
      case "unit":
        break;
    }
    return result;
  }

  private firstInferenceVariable(type: InferenceType): InferenceVariable | null {
    const pruned = this.prune(type);
    switch (pruned.kind) {
      case "variable":
        return pruned;
      case "tuple":
        return this.firstInferenceVariable(pruned.values[0]) ??
          this.firstInferenceVariable(pruned.values[1]);
      case "named":
        for (const argument of pruned.arguments) {
          const unresolved = this.firstInferenceVariable(argument);
          if (unresolved !== null) return unresolved;
        }
        return null;
      case "function":
        return this.firstInferenceVariable(pruned.parameter) ??
          this.firstInferenceVariable(pruned.result);
      case "rigid":
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return null;
    }
  }

  private matchPatternType(pattern: InferenceType, scrutinee: InferenceType): boolean {
    const left = this.prune(pattern);
    const right = this.prune(scrutinee);
    if (left === right) return true;
    if (left.kind === "variable" || right.kind === "variable") return false;
    if (left.kind === "rigid" && right.kind === "rigid") {
      const source = left.scope > right.scope || (left.scope === right.scope && left.id > right.id)
        ? left
        : right;
      return this.refineRigid(source, source === left ? right : left);
    }
    if (left.kind === "rigid") return this.refineRigid(left, right);
    if (right.kind === "rigid") return this.refineRigid(right, left);
    if (left.kind !== right.kind) return false;
    switch (left.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return true;
      case "tuple":
        return right.kind === "tuple" &&
          this.matchPatternType(left.values[0], right.values[0]) &&
          this.matchPatternType(left.values[1], right.values[1]);
      case "named": {
        if (
          right.kind !== "named" || left.name !== right.name ||
          left.arguments.length !== right.arguments.length
        ) return false;
        for (let index = 0; index < left.arguments.length; index++) {
          const leftArgument = left.arguments[index];
          const rightArgument = right.arguments[index];
          if (
            leftArgument === undefined || rightArgument === undefined ||
            !this.matchPatternType(leftArgument, rightArgument)
          ) return false;
        }
        return true;
      }
      case "function":
        return right.kind === "function" &&
          this.matchPatternType(left.parameter, right.parameter) &&
          this.matchPatternType(left.result, right.result);
    }
  }

  private refineRigid(source: RigidVariable, target: InferenceType): boolean {
    if (this.rigidOccurs(source, target)) return false;
    this.#refinementTrail.push({ source, previous: source.refinement });
    source.refinement = target;
    return true;
  }

  private rigidOccurs(source: RigidVariable, type: InferenceType): boolean {
    const pruned = this.prune(type);
    if (pruned === source) return true;
    switch (pruned.kind) {
      case "tuple":
        return this.rigidOccurs(source, pruned.values[0]) ||
          this.rigidOccurs(source, pruned.values[1]);
      case "named":
        return pruned.arguments.some((argument) => this.rigidOccurs(source, argument));
      case "function":
        return this.rigidOccurs(source, pruned.parameter) ||
          this.rigidOccurs(source, pruned.result);
      case "variable":
      case "rigid":
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return false;
    }
  }

  private rollbackRefinements(checkpoint: number): void {
    while (this.#refinementTrail.length > checkpoint) {
      const refinement = this.#refinementTrail.pop();
      if (refinement === undefined) throw new Error("Lazuli refinement trail underflowed.");
      refinement.source.refinement = refinement.previous;
    }
  }

  private unify(
    expected: InferenceType,
    received: InferenceType,
    span: LazuliDiagnostic["span"],
  ): void {
    const left = this.prune(expected);
    const right = this.prune(received);
    if (left === right) return;
    if (left.kind === "variable") {
      this.bindVariable(left, right, span);
      return;
    }
    if (right.kind === "variable") {
      this.bindVariable(right, left, span);
      return;
    }
    if (left.kind === "rigid" || right.kind === "rigid") {
      throw this.typeMismatch(left, right, span);
    }
    if (left.kind !== right.kind) throw this.typeMismatch(left, right, span);
    switch (left.kind) {
      case "integer":
      case "boolean":
      case "unit":
        return;
      case "tuple": {
        if (right.kind !== "tuple") throw this.typeMismatch(left, right, span);
        this.unify(left.values[0], right.values[0], span);
        this.unify(left.values[1], right.values[1], span);
        return;
      }
      case "named": {
        if (
          right.kind !== "named" || left.name !== right.name ||
          left.arguments.length !== right.arguments.length
        ) {
          throw this.typeMismatch(left, right, span);
        }
        for (let index = 0; index < left.arguments.length; index++) {
          const leftArgument = left.arguments[index];
          const rightArgument = right.arguments[index];
          if (leftArgument === undefined || rightArgument === undefined) {
            throw new Error(`Named Lazuli type omitted argument ${index}.`);
          }
          this.unify(leftArgument, rightArgument, span);
        }
        return;
      }
      case "function": {
        if (right.kind !== "function") throw this.typeMismatch(left, right, span);
        this.unify(left.parameter, right.parameter, span);
        this.unify(left.result, right.result, span);
        return;
      }
    }
  }

  private bindVariable(
    variable: InferenceVariable,
    type: InferenceType,
    span: LazuliDiagnostic["span"],
  ): void {
    if (
      this.#untouchableTypeVariableCutoff !== null &&
      variable.id < this.#untouchableTypeVariableCutoff
    ) {
      throw this.invalidTypeMetadata(
        `indexed case arm cannot solve pre-existing inference variable ${
          this.formatType(variable)
        } with ${this.formatType(type)}`,
        span,
      );
    }
    if (this.occurs(variable, type)) {
      throw this.failure(
        "L2103",
        `cannot construct infinite type by unifying ${this.formatType(variable)} with ${
          this.formatType(type)
        }`,
        span,
      );
    }
    variable.instance = type;
  }

  private occurs(variable: InferenceVariable, type: InferenceType): boolean {
    const pruned = this.prune(type);
    if (pruned === variable) return true;
    switch (pruned.kind) {
      case "tuple":
        return this.occurs(variable, pruned.values[0]) || this.occurs(variable, pruned.values[1]);
      case "named":
        return pruned.arguments.some((argument) => this.occurs(variable, argument));
      case "function":
        return this.occurs(variable, pruned.parameter) || this.occurs(variable, pruned.result);
      case "variable":
      case "rigid":
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return false;
    }
  }

  private prune(type: InferenceType): InferenceType {
    if (type.kind === "variable" && type.instance !== null) return this.prune(type.instance);
    if (type.kind === "rigid" && type.refinement !== null) return this.prune(type.refinement);
    return type;
  }

  private typeFromSchema(
    schema: LazuliTypeSchema,
    parameters: Map<string, TypeParameter>,
    parameterPolicy: "declared" | "implicit",
    fallbackSpan: LazuliDiagnostic["span"],
  ): InferenceType {
    const span = this.sourceSpan(schema, fallbackSpan);
    switch (schema.kind) {
      case "integer":
        return INTEGER;
      case "signed-integer-64":
        return SIGNED_INTEGER_64;
      case "float-32":
        return FLOAT_32;
      case "float-64":
        return FLOAT_64;
      case "boolean":
        return BOOLEAN;
      case "unit":
        return UNIT;
      case "parameter": {
        const existing = parameters.get(schema.name);
        if (existing !== undefined) return existing;
        if (parameterPolicy === "declared") {
          throw this.invalidTypeMetadata(
            `type parameter ${JSON.stringify(schema.name)} is not in scope`,
            span,
          );
        }
        const parameter = this.rigidVariable(schema.name);
        parameters.set(schema.name, parameter);
        return parameter;
      }
      case "tuple":
        return {
          kind: "tuple",
          values: [
            this.typeFromSchema(schema.values[0], parameters, parameterPolicy, span),
            this.typeFromSchema(schema.values[1], parameters, parameterPolicy, span),
          ],
        };
      case "named": {
        const declaration = this.#typeByName.get(schema.name);
        if (declaration === undefined) {
          if (parameterPolicy === "implicit" && schema.arguments.length === 0) {
            const existing = parameters.get(schema.name);
            if (existing !== undefined) return existing;
            const parameter = this.rigidVariable(schema.name);
            parameters.set(schema.name, parameter);
            return parameter;
          }
          throw this.invalidTypeMetadata(`unknown type ${JSON.stringify(schema.name)}`, span);
        }
        if (schema.arguments.length !== declaration.arity) {
          throw this.invalidTypeMetadata(
            `type ${
              JSON.stringify(schema.name)
            } expects ${declaration.arity} arguments; received ${schema.arguments.length}`,
            span,
          );
        }
        return {
          kind: "named",
          name: schema.name,
          arguments: schema.arguments.map((argument) =>
            this.typeFromSchema(argument, parameters, parameterPolicy, span)
          ),
        };
      }
      case "function":
        return {
          kind: "function",
          parameter: this.typeFromSchema(schema.parameter, parameters, parameterPolicy, span),
          result: this.typeFromSchema(schema.result, parameters, parameterPolicy, span),
        };
      case "forall":
        throw this.invalidTypeMetadata(
          "higher-rank forall schemas are checked only by the production GPU inferencer",
          span,
        );
    }
  }

  private copySchema(schema: LazuliTypeSchema): LazuliTypeSchema {
    switch (schema.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return Object.freeze({ kind: schema.kind });
      case "parameter":
        return Object.freeze({ kind: "parameter", name: schema.name });
      case "tuple":
        return Object.freeze({
          kind: "tuple",
          values: Object.freeze([
            this.copySchema(schema.values[0]),
            this.copySchema(schema.values[1]),
          ]) as readonly [LazuliTypeSchema, LazuliTypeSchema],
        });
      case "named":
        return Object.freeze({
          kind: "named",
          name: schema.name,
          arguments: Object.freeze(schema.arguments.map((argument) => this.copySchema(argument))),
        });
      case "function":
        return Object.freeze({
          kind: "function",
          parameter: this.copySchema(schema.parameter),
          result: this.copySchema(schema.result),
        });
      case "forall":
        return Object.freeze({
          kind: "forall",
          parameters: Object.freeze([...schema.parameters]),
          body: this.copySchema(schema.body),
        });
    }
  }

  private toPublicType(type: InferenceType): LazuliType {
    const pruned = this.prune(type);
    switch (pruned.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return Object.freeze({ kind: pruned.kind });
      case "tuple":
        return Object.freeze({
          kind: "tuple",
          values: Object.freeze([
            this.toPublicType(pruned.values[0]),
            this.toPublicType(pruned.values[1]),
          ]) as readonly [LazuliType, LazuliType],
        });
      case "named":
        return Object.freeze({
          kind: "named",
          name: pruned.name,
          arguments: Object.freeze(pruned.arguments.map((argument) => this.toPublicType(argument))),
        });
      case "function":
        return Object.freeze({
          kind: "function",
          parameter: this.toPublicType(pruned.parameter),
          result: this.toPublicType(pruned.result),
        });
      case "variable":
      case "rigid":
        throw new Error(`Cannot expose non-concrete Lazuli type ${this.formatType(pruned)}.`);
    }
  }

  private containsTypeParameter(type: InferenceType): boolean {
    const pruned = this.prune(type);
    switch (pruned.kind) {
      case "variable":
      case "rigid":
        return true;
      case "tuple":
        return this.containsTypeParameter(pruned.values[0]) ||
          this.containsTypeParameter(pruned.values[1]);
      case "named":
        return pruned.arguments.some((argument) => this.containsTypeParameter(argument));
      case "function":
        return this.containsTypeParameter(pruned.parameter) ||
          this.containsTypeParameter(pruned.result);
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return false;
    }
  }

  private formatType(type: InferenceType): string {
    const names = new Map<TypeParameter, string>();
    const format = (current: InferenceType, nestedFunction: boolean): string => {
      const pruned = this.prune(current);
      switch (pruned.kind) {
        case "integer":
          return "Int";
        case "signed-integer-64":
          return "I64";
        case "float-32":
          return "F32";
        case "float-64":
          return "F64";
        case "boolean":
          return "Bool";
        case "unit":
          return "()";
        case "variable":
        case "rigid": {
          const existing = names.get(pruned);
          if (existing !== undefined) return existing;
          const name = pruned.kind === "rigid" ? pruned.name : this.typeVariableName(names.size);
          names.set(pruned, name);
          return name;
        }
        case "tuple":
          return `(${format(pruned.values[0], false)}, ${format(pruned.values[1], false)})`;
        case "named":
          return pruned.arguments.length === 0
            ? pruned.name
            : `${pruned.name}[${
              pruned.arguments.map((argument) => format(argument, false)).join(", ")
            }]`;
        case "function": {
          const rendered = `${format(pruned.parameter, true)} -> ${format(pruned.result, false)}`;
          return nestedFunction ? `(${rendered})` : rendered;
        }
      }
    };
    return format(type, false);
  }

  private typeMismatch(
    expected: InferenceType,
    received: InferenceType,
    span: LazuliDiagnostic["span"],
  ): InferenceDiagnostic {
    return this.failure(
      "L2102",
      `type mismatch: expected ${this.formatType(expected)}, received ${this.formatType(received)}`,
      span,
    );
  }

  private invalidTypeMetadata(
    message: string,
    span: LazuliDiagnostic["span"],
  ): InferenceDiagnostic {
    return this.failure("L2101", message, span);
  }

  private failure(
    code: "L2010" | "L2101" | "L2102" | "L2103" | "L2104",
    message: string,
    span: LazuliDiagnostic["span"],
  ): InferenceDiagnostic {
    return new InferenceDiagnostic({ stage: "compile", code, message, span });
  }

  private inferenceVariable(): InferenceVariable {
    return { kind: "variable", id: this.#nextTypeVariable++, instance: null };
  }

  private rigidVariable(
    name: string,
    origin: RigidVariable["origin"] = "ambient",
    scope = 0,
  ): RigidVariable {
    return {
      kind: "rigid",
      id: this.#nextTypeVariable++,
      name,
      origin,
      scope,
      refinement: null,
    };
  }

  private typeVariableName(index: number): string {
    const letter = String.fromCharCode(97 + index % 26);
    const suffix = index < 26 ? "" : Math.floor(index / 26).toString();
    return `'${letter}${suffix}`;
  }

  private caseArmBody(armIndex: number): {
    readonly binders: readonly { readonly symbol: number; readonly nodeIndex: number }[];
    readonly body: number;
  } {
    const binders: { symbol: number; nodeIndex: number }[] = [];
    let body = this.requiredChild(armIndex, LazuliSurfaceWord.Child0);
    while (this.nodeWord(body, LazuliSurfaceWord.Tag) === LazuliSurfaceTag.PatternBind) {
      binders.push({
        symbol: this.nodeWord(body, LazuliSurfaceWord.Payload),
        nodeIndex: body,
      });
      body = this.requiredChild(body, LazuliSurfaceWord.Child0);
    }
    // Surface encoding nests pattern binders right-to-left; field schemas stay source-ordered.
    binders.reverse();
    return { binders, body };
  }

  private requiredChild(nodeIndex: number, word: 4 | 5 | 6): number {
    const child = this.nodeWord(nodeIndex, word);
    if (child === LAZULI_NO_INDEX) {
      throw new Error(`Lazuli node ${nodeIndex} omitted child word ${word}.`);
    }
    return child;
  }

  private nodeWord(nodeIndex: number, word: number): number {
    const value = this.#surface.nodeWords[nodeIndex * LAZULI_NODE_WORD_LENGTH + word];
    if (value === undefined) throw new Error(`Lazuli node ${nodeIndex} omitted word ${word}.`);
    return value;
  }

  private definitionWord(definitionIndex: number, word: number): number {
    const value = this.#surface.definitionWords[
      definitionIndex * LAZULI_DEFINITION_WORD_LENGTH + word
    ];
    if (value === undefined) {
      throw new Error(`Lazuli definition ${definitionIndex} omitted word ${word}.`);
    }
    return value;
  }

  private typeWord(typeIndex: number, word: number): number {
    const value = this.#surface.typeWords[typeIndex * LAZULI_TYPE_WORD_LENGTH + word];
    if (value === undefined) throw new Error(`Lazuli type ${typeIndex} omitted word ${word}.`);
    return value;
  }

  private constructorWord(constructorIndex: number, word: number): number {
    const value = this.#surface.constructorWords[
      constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH + word
    ];
    if (value === undefined) {
      throw new Error(`Lazuli constructor ${constructorIndex} omitted word ${word}.`);
    }
    return value;
  }

  private nodeSpan(nodeIndex: number): LazuliDiagnostic["span"] {
    return {
      startByte: this.nodeWord(nodeIndex, LazuliSurfaceWord.StartByte),
      endByte: this.nodeWord(nodeIndex, LazuliSurfaceWord.EndByte),
    };
  }

  private definitionSpan(definitionIndex: number | undefined): LazuliDiagnostic["span"] {
    if (definitionIndex === undefined) return { startByte: 0, endByte: 0 };
    return {
      startByte: this.definitionWord(definitionIndex, LazuliDefinitionWord.StartByte),
      endByte: this.definitionWord(definitionIndex, LazuliDefinitionWord.EndByte),
    };
  }

  private typeSpan(typeIndex: number): LazuliDiagnostic["span"] {
    return {
      startByte: this.typeWord(typeIndex, LazuliTypeWord.StartByte),
      endByte: this.typeWord(typeIndex, LazuliTypeWord.EndByte),
    };
  }

  private constructorSpan(constructorIndex: number): LazuliDiagnostic["span"] {
    return {
      startByte: this.constructorWord(constructorIndex, LazuliConstructorWord.StartByte),
      endByte: this.constructorWord(constructorIndex, LazuliConstructorWord.EndByte),
    };
  }

  private sourceSpan(
    schema: LazuliTypeSchema,
    fallback: LazuliDiagnostic["span"],
  ): LazuliDiagnostic["span"] {
    const source = schema as Partial<LazuliSourceType>;
    return typeof source.startByte === "number" && typeof source.endByte === "number"
      ? { startByte: source.startByte, endByte: source.endByte }
      : fallback;
  }

  private symbolName(symbol: number): string {
    return this.#surface.symbolNames[symbol] ?? `<symbol ${symbol}>`;
  }

  private withBoundSymbol(boundSymbols: ReadonlySet<number>, symbol: number): ReadonlySet<number> {
    const next = new Set(boundSymbols);
    next.add(symbol);
    return next;
  }

  private requiredMapValue<K, V>(values: ReadonlyMap<K, V>, key: K): V {
    const value = values.get(key);
    if (value === undefined) throw new Error("Lazuli inference map omitted a required value.");
    return value;
  }
}

/**
 * Infers rank-1 HM types from the encoded surface tree. The frontend supplies one
 * `definitionTypes` entry per definition and one `typeDeclarations` entry per encoded type;
 * constructors and their fields remain in the same order as the word-buffer ABI.
 */
export function inferLazuliTypes(surface: EncodedLazuliSurface): LazuliTypeInferenceResult {
  try {
    return new InferenceContext(surface).infer();
  } catch (error) {
    if (error instanceof InferenceDiagnostic) return { ok: false, diagnostic: error.diagnostic };
    throw error;
  }
}
