import type { FunctionalType, FunctionalTypeDeclaration, FunctionalTypeSchema } from "./abi.ts";
import { completeFunctionalTypeDeclarations, type GpuFunctionalModule } from "./compiler_module.ts";
import {
  FUNCTIONAL_ARRAY_TYPE_NAME,
  FUNCTIONAL_BYTES_TYPE_NAME,
  FUNCTIONAL_ERASED_TYPE_NAME,
  FUNCTIONAL_RESOURCE_TYPE_PREFIX,
  FUNCTIONAL_SLICE_TYPE_NAME,
  FUNCTIONAL_TEXT_TYPE_NAME,
  FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME,
  type FunctionalHostFieldDeclaration,
} from "./host_contract.ts";
import { compileFunctionalModuleToWasm } from "./wasm_artifacts.ts";
import type {
  FunctionalComponentBoundaryArtifact,
  FunctionalComponentBoundaryOptions,
} from "./wasm_contract.ts";

const WIT_UNIT_TYPE_NAME = "gpufuck-unit";
const WIT_KEYWORDS = new Set([
  "as",
  "async",
  "bool",
  "borrow",
  "enum",
  "export",
  "flags",
  "func",
  "future",
  "import",
  "include",
  "interface",
  "list",
  "option",
  "own",
  "package",
  "record",
  "resource",
  "result",
  "static",
  "stream",
  "string",
  "tuple",
  "type",
  "use",
  "variant",
  "with",
  "world",
]);

export function functionalWitWorld(
  module: GpuFunctionalModule,
  options: FunctionalComponentBoundaryOptions = {},
): string {
  const packageName = options.packageName ?? "gpufuck:compiled";
  if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(packageName)) {
    throw new TypeError(
      `functional component package name ${
        JSON.stringify(packageName)
      } must be namespace:name in kebab-case`,
    );
  }
  const names = new WitNames();
  const worldName = names.claim(options.worldName ?? "functional-module", "world");
  const declarations = completeFunctionalTypeDeclarations(module);
  const typeNames = new Map(
    declarations.map((declaration) => [declaration.name, names.claim(declaration.name, "type")]),
  );
  const resources = collectResourceNames(module, declarations);
  const resourceNames = resources.map((resource) => names.claim(resource, "resource"));
  const unitTypeName = names.claim(WIT_UNIT_TYPE_NAME, "reserved unit type");
  const sharedTypeNames = [unitTypeName, ...resourceNames, ...typeNames.values()];
  const typesInterface = names.claim("functional-types", "interface");
  const lines = [`package ${packageName};`, ""];
  lines.push(`interface ${typesInterface} {`);
  lines.push(`  enum ${unitTypeName} { unit }`);
  for (const resourceName of resourceNames) lines.push(`  resource ${resourceName};`);
  for (const declaration of declarations) {
    lines.push(...witTypeDeclaration(declaration, typeNames, names).map((line) => `  ${line}`));
  }
  lines.push("}", "");
  for (const capability of module.hostCapabilities) {
    const capabilityName = names.claim(capability.name, "capability");
    lines.push(`interface ${capabilityName} {`);
    lines.push(`  use ${typesInterface}.{${sharedTypeNames.join(", ")}};`);
    for (const field of capability.fields) {
      lines.push(`  ${witHostField(field, typeNames, names)}`);
    }
    lines.push("}", "");
  }
  lines.push(`world ${worldName} {`);
  lines.push(`  use ${typesInterface}.{${sharedTypeNames.join(", ")}};`);
  for (const capability of module.hostCapabilities) {
    lines.push(`  import ${names.claim(capability.name, "capability")};`);
  }
  lines.push(`  export main: ${witFunction(module.entryType, typeNames, names)};`);
  for (const exported of module.wasmExports) {
    lines.push(
      `  export ${names.claim(exported.name, "export")}: ${
        witFunction(exported.type, typeNames, names)
      };`,
    );
  }
  lines.push("}", "");
  return lines.join("\n");
}

export async function compileFunctionalComponentBoundary(
  module: GpuFunctionalModule,
  options: FunctionalComponentBoundaryOptions = {},
): Promise<FunctionalComponentBoundaryArtifact> {
  const [coreWasm, wit] = await Promise.all([
    compileFunctionalModuleToWasm(module),
    Promise.resolve(functionalWitWorld(module, options)),
  ]);
  return Object.freeze({ coreWasm, wit });
}

function witTypeDeclaration(
  declaration: FunctionalTypeDeclaration,
  typeNames: ReadonlyMap<string, string>,
  names: WitNames,
): readonly string[] {
  if (declaration.parameters.length !== 0) {
    throw new TypeError(
      `functional component type ${
        JSON.stringify(declaration.name)
      } has ${declaration.parameters.length} generic parameters; WIT boundaries require concrete monomorphized types`,
    );
  }
  for (const constructor of declaration.constructors) {
    if (constructor.result === undefined) continue;
    if (
      constructor.result.kind !== "named" || constructor.result.name !== declaration.name ||
      constructor.result.arguments.length !== 0
    ) {
      throw new TypeError(
        `functional component constructor ${
          JSON.stringify(constructor.name)
        } has indexed result outside concrete type ${JSON.stringify(declaration.name)}`,
      );
    }
  }
  const typeName = typeNames.get(declaration.name);
  if (typeName === undefined) {
    throw new Error(
      `functional component omitted WIT name for type ${JSON.stringify(declaration.name)}`,
    );
  }
  if (declaration.constructors.length === 1) {
    const constructor = declaration.constructors[0]!;
    if (constructor.fields.length === 0) {
      return [
        `enum ${typeName} {`,
        `  ${names.local(constructor.name, `${declaration.name} constructor`)},`,
        "}",
      ];
    }
    const lines = [`record ${typeName} {`];
    for (const [fieldIndex, field] of constructor.fields.entries()) {
      const fieldName = names.local(
        field.name || `field-${fieldIndex}`,
        `${declaration.name} field`,
      );
      lines.push(`  ${fieldName}: ${witType(field.type, typeNames, names)},`);
    }
    lines.push("}");
    return lines;
  }
  const lines = [`variant ${typeName} {`];
  for (const constructor of declaration.constructors) {
    const constructorName = names.local(constructor.name, `${declaration.name} constructor`);
    if (constructor.fields.length === 0) {
      lines.push(`  ${constructorName},`);
      continue;
    }
    const fields = constructor.fields.map((field) => witType(field.type, typeNames, names));
    const payload = fields.length === 1 ? fields[0] : `tuple<${fields.join(", ")}>`;
    lines.push(`  ${constructorName}(${payload}),`);
  }
  lines.push("}");
  return lines;
}

function witHostField(
  field: FunctionalHostFieldDeclaration,
  typeNames: ReadonlyMap<string, string>,
  names: WitNames,
): string {
  const name = names.local(field.name, "host field");
  if (field.kind === "value") {
    const type = field.representation ?? field.type;
    return type.kind === "unit"
      ? `${name}: func();`
      : `${name}: func() -> ${witType(type, typeNames, names)};`;
  }
  const async = field.execution === "suspending" ? "async " : "";
  const parameterType = field.parameterRepresentation ?? field.parameter;
  const resultType = field.resultRepresentation ?? field.result;
  const parameters = parameterType.kind === "unit"
    ? ""
    : `value: ${witType(parameterType, typeNames, names)}`;
  const result = resultType.kind === "unit" ? "" : ` -> ${witType(resultType, typeNames, names)}`;
  return `${name}: ${async}func(${parameters})${result};`;
}

function witFunction(
  type: FunctionalType,
  typeNames: ReadonlyMap<string, string>,
  names: WitNames,
): string {
  const parameters: string[] = [];
  let result = type;
  let parameterIndex = 0;
  while (result.kind === "function") {
    if (result.parameter.kind !== "unit") {
      parameters.push(`argument-${parameterIndex}: ${witType(result.parameter, typeNames, names)}`);
    }
    result = result.result;
    parameterIndex += 1;
  }
  return result.kind === "unit"
    ? `func(${parameters.join(", ")})`
    : `func(${parameters.join(", ")}) -> ${witType(result, typeNames, names)}`;
}

function witType(
  type: FunctionalTypeSchema,
  typeNames: ReadonlyMap<string, string>,
  names: WitNames,
): string {
  switch (type.kind) {
    case "integer":
      return "s32";
    case "signed-integer-64":
      return "s64";
    case "float-32":
      return "f32";
    case "float-64":
      return "f64";
    case "boolean":
      return "bool";
    case "unit":
      return WIT_UNIT_TYPE_NAME;
    case "tuple":
      return `tuple<${witType(type.values[0], typeNames, names)}, ${
        witType(type.values[1], typeNames, names)
      }>`;
    case "function":
      throw new TypeError("functional component values cannot contain a function type");
    case "parameter":
      throw new TypeError(
        `functional component boundary retains type parameter ${JSON.stringify(type.name)}`,
      );
    case "forall":
      throw new TypeError("functional component boundaries require monomorphic exported types");
    case "named": {
      if (type.name === FUNCTIONAL_TEXT_TYPE_NAME) return "string";
      if (type.name === FUNCTIONAL_BYTES_TYPE_NAME) return "list<u8>";
      if (type.name === FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME) return "f64";
      if (type.name === FUNCTIONAL_ERASED_TYPE_NAME) {
        throw new TypeError("functional component boundaries cannot expose erased runtime values");
      }
      if (type.name === FUNCTIONAL_ARRAY_TYPE_NAME || type.name === FUNCTIONAL_SLICE_TYPE_NAME) {
        const element = type.arguments[0];
        if (element === undefined || type.arguments.length !== 1) {
          throw new TypeError(
            `functional component collection ${
              JSON.stringify(type.name)
            } requires one element type`,
          );
        }
        return `list<${witType(element, typeNames, names)}>`;
      }
      if (type.name.startsWith(FUNCTIONAL_RESOURCE_TYPE_PREFIX)) {
        const encoded = type.name.slice(FUNCTIONAL_RESOURCE_TYPE_PREFIX.length);
        return names.claim(decodeURIComponent(encoded), "resource");
      }
      const declared = typeNames.get(type.name);
      if (declared === undefined) {
        throw new TypeError(
          `functional component boundary references undeclared type ${JSON.stringify(type.name)}`,
        );
      }
      if (type.arguments.length !== 0) {
        throw new TypeError(
          `functional component boundary type ${
            JSON.stringify(type.name)
          } retains ${type.arguments.length} generic arguments; monomorphize it before WIT generation`,
        );
      }
      return declared;
    }
  }
}

function collectResourceNames(
  module: GpuFunctionalModule,
  declarations: readonly FunctionalTypeDeclaration[],
): readonly string[] {
  const resources = new Set<string>();
  const visit = (type: FunctionalTypeSchema): void => {
    if (type.kind === "tuple") {
      visit(type.values[0]);
      visit(type.values[1]);
      return;
    }
    if (type.kind === "function") {
      visit(type.parameter);
      visit(type.result);
      return;
    }
    if (type.kind === "forall") {
      visit(type.body);
      return;
    }
    if (type.kind !== "named") return;
    if (type.name.startsWith(FUNCTIONAL_RESOURCE_TYPE_PREFIX)) {
      resources.add(decodeURIComponent(type.name.slice(FUNCTIONAL_RESOURCE_TYPE_PREFIX.length)));
    }
    for (const argument of type.arguments) visit(argument);
  };
  visit(module.entryType);
  for (const exported of module.wasmExports) visit(exported.type);
  for (const capability of module.hostCapabilities) {
    for (const field of capability.fields) {
      if (field.kind === "value") visit(field.representation ?? field.type);
      else {
        visit(field.parameterRepresentation ?? field.parameter);
        visit(field.resultRepresentation ?? field.result);
      }
    }
  }
  for (const declaration of declarations) {
    for (const constructor of declaration.constructors) {
      for (const field of constructor.fields) visit(field.type);
    }
  }
  return Object.freeze([...resources]);
}

class WitNames {
  readonly #claimed = new Map<string, { readonly source: string; readonly kind: string }>();

  claim(source: string, kind: string): string {
    const identifier = this.local(source, kind);
    const existing = this.#claimed.get(identifier);
    if (existing !== undefined && (existing.source !== source || existing.kind !== kind)) {
      throw new TypeError(
        `functional component ${existing.kind} ${JSON.stringify(existing.source)} and ${kind} ${
          JSON.stringify(source)
        } both map to WIT identifier ${JSON.stringify(identifier)}`,
      );
    }
    this.#claimed.set(identifier, { source, kind });
    return identifier;
  }

  local(source: string, kind: string): string {
    const identifier = source
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    if (identifier.length === 0 || !/^[a-z]/.test(identifier)) {
      throw new TypeError(
        `functional component ${kind} ${JSON.stringify(source)} cannot form a WIT identifier`,
      );
    }
    return WIT_KEYWORDS.has(identifier) ? `%${identifier}` : identifier;
  }
}
