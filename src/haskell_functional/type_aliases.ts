import type {
  HaskellFunctionalClassDeclaration,
  HaskellFunctionalDeclaration,
  HaskellFunctionalInstanceDeclaration,
  HaskellFunctionalProgram,
  HaskellFunctionalType,
  HaskellFunctionalTypeAliasDeclaration,
  HaskellFunctionalTypeDeclaration,
  HaskellFunctionalTypeSignature,
} from "./ast.ts";
import { HaskellFunctionalLoweringError } from "./diagnostic.ts";

export function expandHaskellTypeAliases(
  program: HaskellFunctionalProgram,
): HaskellFunctionalProgram {
  const aliases = new Map<string, HaskellFunctionalTypeAliasDeclaration>();
  const declaredTypes = new Map<string, HaskellFunctionalDeclaration>();
  for (const declaration of program.declarations) {
    if (declaration.kind !== "type" && declaration.kind !== "type-alias") continue;
    const existing = declaredTypes.get(declaration.name);
    if (existing !== undefined) {
      throw new HaskellFunctionalLoweringError(
        declaration.span,
        `Haskell source repeats type ${JSON.stringify(declaration.name)}; ` +
          `the first declaration starts at byte ${existing.span.startByte}.`,
      );
    }
    declaredTypes.set(declaration.name, declaration);
    if (declaration.kind !== "type-alias") continue;
    requireUniqueAliasParameters(declaration);
    requireBoundAliasParameters(declaration.target, new Set(declaration.parameters), declaration);
    aliases.set(declaration.name, declaration);
  }
  for (const alias of aliases.values()) {
    requireKnownAliasTypes(alias.target, declaredTypes, alias);
    const substitutions = new Map(
      alias.parameters.map((parameter) => [
        parameter,
        { kind: "parameter", name: parameter, span: alias.span } as const,
      ]),
    );
    expandType(alias.target, aliases, substitutions, [alias.name]);
  }

  const declarations: HaskellFunctionalDeclaration[] = [];
  for (const declaration of program.declarations) {
    switch (declaration.kind) {
      case "type-alias":
        break;
      case "type":
        declarations.push(expandTypeDeclaration(declaration, aliases));
        break;
      case "signature":
        declarations.push(expandSignature(declaration, aliases));
        break;
      case "class":
        declarations.push(expandClass(declaration, aliases));
        break;
      case "instance":
        declarations.push(expandInstance(declaration, aliases));
        break;
      case "definition":
        declarations.push(declaration);
        break;
    }
  }
  return { ...program, declarations };
}

function requireKnownAliasTypes(
  type: HaskellFunctionalType,
  declaredTypes: ReadonlyMap<string, HaskellFunctionalDeclaration>,
  alias: HaskellFunctionalTypeAliasDeclaration,
): void {
  switch (type.kind) {
    case "integer":
    case "character":
    case "boolean":
    case "unit":
    case "parameter":
      return;
    case "list":
      requireKnownAliasTypes(type.value, declaredTypes, alias);
      return;
    case "tuple":
      requireKnownAliasTypes(type.values[0], declaredTypes, alias);
      requireKnownAliasTypes(type.values[1], declaredTypes, alias);
      return;
    case "function":
      requireKnownAliasTypes(type.parameter, declaredTypes, alias);
      requireKnownAliasTypes(type.result, declaredTypes, alias);
      return;
    case "forall":
      requireKnownAliasTypes(type.body, declaredTypes, alias);
      return;
    case "named": {
      const declaration = declaredTypes.get(type.name);
      if (declaration === undefined) {
        throw new HaskellFunctionalLoweringError(
          type.span,
          `Type synonym ${JSON.stringify(alias.name)} references unknown type ${
            JSON.stringify(type.name)
          }.`,
        );
      }
      if (declaration.kind !== "type" && declaration.kind !== "type-alias") {
        throw new Error(`Haskell type index retained non-type declaration ${declaration.kind}.`);
      }
      if (type.arguments.length !== declaration.parameters.length) {
        throw new HaskellFunctionalLoweringError(
          type.span,
          `Type synonym ${JSON.stringify(alias.name)} applies ${JSON.stringify(type.name)} to ` +
            `${type.arguments.length} arguments; expected ${declaration.parameters.length}.`,
        );
      }
      for (const argument of type.arguments) {
        requireKnownAliasTypes(argument, declaredTypes, alias);
      }
    }
  }
}

function expandTypeDeclaration(
  declaration: HaskellFunctionalTypeDeclaration,
  aliases: ReadonlyMap<string, HaskellFunctionalTypeAliasDeclaration>,
): HaskellFunctionalTypeDeclaration {
  return {
    ...declaration,
    constructors: declaration.constructors.map((constructor) => ({
      ...constructor,
      fields: constructor.fields.map((field) => ({
        ...field,
        type: expandType(field.type, aliases),
      })),
      ...(constructor.result === undefined
        ? {}
        : { result: expandType(constructor.result, aliases) }),
    })),
  };
}

function expandSignature(
  signature: HaskellFunctionalTypeSignature,
  aliases: ReadonlyMap<string, HaskellFunctionalTypeAliasDeclaration>,
): HaskellFunctionalTypeSignature {
  return {
    ...signature,
    constraints: signature.constraints.map((constraint) => ({
      ...constraint,
      type: expandType(constraint.type, aliases),
    })),
    type: expandType(signature.type, aliases),
  };
}

function expandClass(
  declaration: HaskellFunctionalClassDeclaration,
  aliases: ReadonlyMap<string, HaskellFunctionalTypeAliasDeclaration>,
): HaskellFunctionalClassDeclaration {
  return {
    ...declaration,
    methods: declaration.methods.map((method) => expandSignature(method, aliases)),
  };
}

function expandInstance(
  declaration: HaskellFunctionalInstanceDeclaration,
  aliases: ReadonlyMap<string, HaskellFunctionalTypeAliasDeclaration>,
): HaskellFunctionalInstanceDeclaration {
  return { ...declaration, type: expandType(declaration.type, aliases) };
}

function expandType(
  type: HaskellFunctionalType,
  aliases: ReadonlyMap<string, HaskellFunctionalTypeAliasDeclaration>,
  substitutions: ReadonlyMap<string, HaskellFunctionalType> = new Map(),
  expansionPath: readonly string[] = [],
): HaskellFunctionalType {
  switch (type.kind) {
    case "integer":
    case "character":
    case "boolean":
    case "unit":
      return type;
    case "parameter":
      return substitutions.get(type.name) ?? type;
    case "list":
      return { ...type, value: expandType(type.value, aliases, substitutions, expansionPath) };
    case "tuple":
      return {
        ...type,
        values: [
          expandType(type.values[0], aliases, substitutions, expansionPath),
          expandType(type.values[1], aliases, substitutions, expansionPath),
        ],
      };
    case "function":
      return {
        ...type,
        parameter: expandType(type.parameter, aliases, substitutions, expansionPath),
        result: expandType(type.result, aliases, substitutions, expansionPath),
      };
    case "forall": {
      const bodySubstitutions = new Map(substitutions);
      for (const parameter of type.parameters) bodySubstitutions.delete(parameter);
      return {
        ...type,
        body: expandType(type.body, aliases, bodySubstitutions, expansionPath),
      };
    }
    case "named": {
      const arguments_ = type.arguments.map((argument) =>
        expandType(argument, aliases, substitutions, expansionPath)
      );
      const alias = aliases.get(type.name);
      if (alias === undefined) return { ...type, arguments: arguments_ };
      if (arguments_.length !== alias.parameters.length) {
        throw new HaskellFunctionalLoweringError(
          type.span,
          `Type synonym ${
            JSON.stringify(type.name)
          } expects ${alias.parameters.length} arguments; ` +
            `received ${arguments_.length}.`,
        );
      }
      const cycleStart = expansionPath.indexOf(type.name);
      if (cycleStart >= 0) {
        const cycle = [...expansionPath.slice(cycleStart), type.name].join(" -> ");
        throw new HaskellFunctionalLoweringError(
          type.span,
          `Haskell type synonyms form a cycle: ${cycle}.`,
        );
      }
      const aliasSubstitutions = new Map<string, HaskellFunctionalType>();
      for (const [index, parameter] of alias.parameters.entries()) {
        const argument = arguments_[index];
        if (argument === undefined) {
          throw new Error(`Type synonym ${type.name} omitted argument ${index}.`);
        }
        aliasSubstitutions.set(parameter, argument);
      }
      const expanded = expandType(
        alias.target,
        aliases,
        aliasSubstitutions,
        [...expansionPath, type.name],
      );
      return { ...expanded, span: type.span };
    }
  }
}

function requireUniqueAliasParameters(declaration: HaskellFunctionalTypeAliasDeclaration): void {
  const received = new Set<string>();
  for (const parameter of declaration.parameters) {
    if (!received.has(parameter)) {
      received.add(parameter);
      continue;
    }
    throw new HaskellFunctionalLoweringError(
      declaration.span,
      `Type synonym ${JSON.stringify(declaration.name)} repeats parameter ${
        JSON.stringify(parameter)
      }.`,
    );
  }
}

function requireBoundAliasParameters(
  type: HaskellFunctionalType,
  parameters: ReadonlySet<string>,
  declaration: HaskellFunctionalTypeAliasDeclaration,
): void {
  switch (type.kind) {
    case "integer":
    case "character":
    case "boolean":
    case "unit":
      return;
    case "parameter":
      if (parameters.has(type.name)) return;
      throw new HaskellFunctionalLoweringError(
        type.span,
        `Type synonym ${JSON.stringify(declaration.name)} uses undeclared parameter ${
          JSON.stringify(type.name)
        }.`,
      );
    case "list":
      requireBoundAliasParameters(type.value, parameters, declaration);
      return;
    case "tuple":
      requireBoundAliasParameters(type.values[0], parameters, declaration);
      requireBoundAliasParameters(type.values[1], parameters, declaration);
      return;
    case "named":
      for (const argument of type.arguments) {
        requireBoundAliasParameters(argument, parameters, declaration);
      }
      return;
    case "function":
      requireBoundAliasParameters(type.parameter, parameters, declaration);
      requireBoundAliasParameters(type.result, parameters, declaration);
      return;
    case "forall": {
      const nestedParameters = new Set(parameters);
      for (const parameter of type.parameters) nestedParameters.add(parameter);
      requireBoundAliasParameters(type.body, nestedParameters, declaration);
    }
  }
}
