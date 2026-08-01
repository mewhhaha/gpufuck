import type { CompiledModule } from "./compiler_module.ts";
import {
  canonicalAbiCoreSignature,
  type CanonicalAbiFunction,
  type CanonicalAbiInterface,
  type CanonicalAbiType,
  validateCanonicalAbiInterface,
} from "./canonical_abi.ts";
import { compileModuleToWasm } from "./wasm_artifacts.ts";
import type { ComponentBoundaryArtifact, ComponentBoundaryOptions } from "./wasm_contract.ts";

const DEFAULT_COMPONENT_PACKAGE = "mewhhaha:gpufuck";
const DEFAULT_COMPONENT_WORLD = "gpufuck";
const WIT_IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WIT_KEYWORDS = new Set([
  "as",
  "bool",
  "borrow",
  "char",
  "constructor",
  "enum",
  "export",
  "flags",
  "float32",
  "float64",
  "from",
  "func",
  "future",
  "import",
  "include",
  "instance",
  "interface",
  "list",
  "option",
  "own",
  "package",
  "record",
  "resource",
  "result",
  "s16",
  "s32",
  "s64",
  "s8",
  "static",
  "stream",
  "string",
  "tuple",
  "type",
  "u16",
  "u32",
  "u64",
  "u8",
  "use",
  "variant",
  "with",
  "world",
]);
const WIT_PACKAGE =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?$/;

export async function compileModuleToComponentBoundary(
  module: CompiledModule,
  canonicalAbi: CanonicalAbiInterface,
  options: ComponentBoundaryOptions = {},
): Promise<ComponentBoundaryArtifact> {
  validateComponentBoundaryOptions(options);
  validateCanonicalAbiInterface(canonicalAbi);
  validateLegacyCanonicalNames(canonicalAbi);
  const wit = renderComponentWit(canonicalAbi, {
    packageName: options.packageName ?? DEFAULT_COMPONENT_PACKAGE,
    worldName: options.worldName ?? DEFAULT_COMPONENT_WORLD,
  });
  const coreWasm = await compileModuleToWasm(module, { canonicalAbi });
  return { coreWasm, wit };
}

function renderComponentWit(
  canonicalAbi: CanonicalAbiInterface,
  options: Required<ComponentBoundaryOptions>,
): string {
  validateCanonicalAbiInterface(canonicalAbi);
  requireWitPackage(options.packageName);
  const worldName = requireWitIdentifier(options.worldName, "world name");
  const renderer = new WitRenderer(canonicalAbi);
  return renderer.render(options.packageName, worldName);
}

class WitRenderer {
  readonly #canonicalAbi: CanonicalAbiInterface;
  readonly #typeNames = new Map<string, string>();
  readonly #declarations: string[] = [];

  constructor(canonicalAbi: CanonicalAbiInterface) {
    this.#canonicalAbi = canonicalAbi;
  }

  render(packageName: string, worldName: string): string {
    const imports = this.#canonicalAbi.imports.map((imported) => {
      const operation = requireWitIdentifier(
        imported.operation,
        `import operation ${JSON.stringify(imported.operation)}`,
      );
      return `  import ${operation}: ${this.#function(imported.function)};`;
    });
    const exports = this.#canonicalAbi.exports.map((exported) => {
      const name = requireWitIdentifier(
        exported.name,
        `export name ${JSON.stringify(exported.name)}`,
      );
      return `  export ${name}: ${this.#function(exported.function)};`;
    });
    const functions = [...imports, ...exports];
    const declarations = this.#declarations.map((declaration) => `  ${declaration}`);
    const body = [
      ...declarations,
      ...(declarations.length > 0 && functions.length > 0 ? [""] : []),
      ...functions,
    ];
    return `package ${packageName};\n\nworld ${worldName} {\n${body.join("\n")}\n}\n`;
  }

  #function(function_: CanonicalAbiFunction): string {
    const parameters = function_.parameters.map((parameter, index) =>
      `argument-${index}: ${this.#type(parameter)}`
    );
    const result = function_.result.kind === "unit" ? "" : ` -> ${this.#type(function_.result)}`;
    return `func(${parameters.join(", ")})${result}`;
  }

  #type(type: CanonicalAbiType): string {
    if (type.kind === "unit") return "tuple<>";
    if (type.kind === "signed-integer-64") return "s64";
    if (type.kind === "float-32") return "float32";
    if (type.kind === "float-64") return "float64";
    if (type.kind === "boolean") return "bool";
    if (type.kind === "text") return "string";
    if (type.kind === "array") return `list<${this.#type(type.element)}>`;

    const fingerprint = witTypeFingerprint(type);
    const existing = this.#typeNames.get(fingerprint);
    if (existing !== undefined) return existing;
    const typeName = type.kind === "sealed"
      ? requireWitIdentifier(type.name, `sealed type name ${JSON.stringify(type.name)}`)
      : `boundary-type-${this.#typeNames.size}`;
    if ([...this.#typeNames.values()].includes(typeName)) {
      throw new TypeError(`component boundary repeats WIT type name ${JSON.stringify(typeName)}`);
    }
    this.#typeNames.set(fingerprint, typeName);
    if (type.kind === "sealed") {
      this.#declarations.push(`type ${typeName} = ${this.#type(type.inner)};`);
      return typeName;
    }
    if (type.kind === "record") {
      const fields = type.fields.map((field) => {
        const fieldName = requireWitIdentifier(
          field.name,
          `record field ${JSON.stringify(field.name)}`,
        );
        return `    ${fieldName}: ${this.#type(field.type)},`;
      });
      this.#declarations.push(`record ${typeName} {\n${fields.join("\n")}\n  }`);
      return typeName;
    }
    const cases = type.cases.map((case_) => {
      const caseName = requireWitIdentifier(
        case_.name,
        `variant case ${JSON.stringify(case_.name)}`,
      );
      return case_.payload === undefined
        ? `    ${caseName},`
        : `    ${caseName}(${this.#type(case_.payload)}),`;
    });
    this.#declarations.push(`variant ${typeName} {\n${cases.join("\n")}\n  }`);
    return typeName;
  }
}

function validateComponentBoundaryOptions(options: ComponentBoundaryOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("component boundary options must be an object");
  }
  if (options.packageName !== undefined) requireWitPackage(options.packageName);
  if (options.worldName !== undefined) requireWitIdentifier(options.worldName, "world name");
}

function validateLegacyCanonicalNames(canonicalAbi: CanonicalAbiInterface): void {
  for (const exported of canonicalAbi.exports) {
    const signature = canonicalAbiCoreSignature(exported.function, "export");
    if (!signature.indirectResult) continue;
    const expected = `cabi_post_${exported.name}`;
    if (exported.postReturn !== expected) {
      throw new TypeError(
        `component export ${JSON.stringify(exported.name)} requires legacy post-return ${
          JSON.stringify(expected)
        }; received ${JSON.stringify(exported.postReturn)}`,
      );
    }
  }
  const importOperations = new Set<string>();
  for (const imported of canonicalAbi.imports) {
    if (importOperations.has(imported.operation)) {
      throw new TypeError(
        `component boundary repeats root import ${JSON.stringify(imported.operation)}`,
      );
    }
    importOperations.add(imported.operation);
    if (imported.module !== "$root" || imported.name !== imported.operation) {
      throw new TypeError(
        `component import ${
          JSON.stringify(`${imported.capability}.${imported.operation}`)
        } requires Core import ${JSON.stringify(`$root.${imported.operation}`)}; received ${
          JSON.stringify(`${imported.module}.${imported.name}`)
        }`,
      );
    }
  }
}

function witTypeFingerprint(type: CanonicalAbiType): string {
  if (
    type.kind === "unit" || type.kind === "signed-integer-64" ||
    type.kind === "float-32" || type.kind === "float-64" ||
    type.kind === "boolean" || type.kind === "text"
  ) return type.kind;
  if (type.kind === "array") return `array(${witTypeFingerprint(type.element)})`;
  if (type.kind === "sealed") return `sealed(${type.name},${witTypeFingerprint(type.inner)})`;
  if (type.kind === "record") {
    return `record(${
      type.fields.map((field) => `${field.name}:${witTypeFingerprint(field.type)}`).join(",")
    })`;
  }
  return `variant(${
    type.cases.map((case_) =>
      case_.payload === undefined
        ? case_.name
        : `${case_.name}:${witTypeFingerprint(case_.payload)}`
    ).join(",")
  })`;
}

function requireWitPackage(packageName: string): void {
  if (!WIT_PACKAGE.test(packageName)) {
    throw new TypeError(
      `component package must be namespace:name with an optional semantic version; received ${
        JSON.stringify(packageName)
      }`,
    );
  }
}

function requireWitIdentifier(identifier: string, location: string): string {
  if (!WIT_IDENTIFIER.test(identifier)) {
    throw new TypeError(
      `component ${location} must be a lower-kebab WIT identifier; received ${
        JSON.stringify(identifier)
      }`,
    );
  }
  return WIT_KEYWORDS.has(identifier) ? `%${identifier}` : identifier;
}
