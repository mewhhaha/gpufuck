import type { FunctionalTypeSchema } from "./abi.ts";

export const FUNCTIONAL_INIT_TYPE_NAME = "$FunctionalInitType";
export const FUNCTIONAL_INIT_CONSTRUCTOR_NAME = "$FunctionalInit";

export type FunctionalHostScalarType =
  | { readonly kind: "integer" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" };

export interface FunctionalHostValueDeclaration {
  readonly kind: "value";
  readonly name: string;
  readonly type: FunctionalHostScalarType;
}

export interface FunctionalHostOperationDeclaration {
  readonly kind: "operation";
  readonly name: string;
  readonly purity: "pure" | "effectful";
  readonly parameter: FunctionalHostScalarType;
  readonly result: FunctionalHostScalarType;
}

export type FunctionalHostFieldDeclaration =
  | FunctionalHostValueDeclaration
  | FunctionalHostOperationDeclaration;

export interface FunctionalHostCapabilityDeclaration {
  readonly name: string;
  readonly fields: readonly FunctionalHostFieldDeclaration[];
}

export interface FunctionalSurfaceModuleOptions {
  readonly hostCapabilities?: readonly FunctionalHostCapabilityDeclaration[];
}

export type FunctionalWasmHostOperation = (
  argument: FunctionalWasmHostValue,
) => FunctionalWasmHostValue;

export type FunctionalWasmHostValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "unit" };

export type FunctionalWasmInitBinding = FunctionalWasmHostValue | FunctionalWasmHostOperation;

export interface FunctionalWasmInit {
  readonly [capability: string]: Readonly<Record<string, FunctionalWasmInitBinding>>;
}

export function normalizeFunctionalHostCapabilities(
  declarations: readonly FunctionalHostCapabilityDeclaration[] | undefined,
): readonly FunctionalHostCapabilityDeclaration[] {
  if (declarations === undefined) return Object.freeze([]);
  if (!Array.isArray(declarations)) {
    throw new TypeError("functional host capabilities must be an array");
  }
  const capabilities: readonly FunctionalHostCapabilityDeclaration[] = declarations;
  const capabilityNames = new Set<string>();
  return Object.freeze(capabilities.map((declaration, capabilityIndex) => {
    if (declaration === null || typeof declaration !== "object") {
      throw new TypeError(
        `functional host capability ${capabilityIndex} must be an object; received ${
          JSON.stringify(declaration)
        }`,
      );
    }
    requireName(declaration.name, `capability ${capabilityIndex} name`);
    if (capabilityNames.has(declaration.name)) {
      throw new Error(
        `functional host capabilities repeat capability ${JSON.stringify(declaration.name)}`,
      );
    }
    capabilityNames.add(declaration.name);
    if (!Array.isArray(declaration.fields)) {
      throw new TypeError(
        `functional host capability ${JSON.stringify(declaration.name)} fields must be an array`,
      );
    }
    const declaredFields: readonly FunctionalHostFieldDeclaration[] = declaration.fields;
    const fieldNames = new Set<string>();
    const fields = declaredFields.map((field, fieldIndex) => {
      if (field === null || typeof field !== "object") {
        throw new TypeError(
          `functional host capability ${
            JSON.stringify(declaration.name)
          } field ${fieldIndex} must be an object; received ${JSON.stringify(field)}`,
        );
      }
      requireName(
        field.name,
        `capability ${JSON.stringify(declaration.name)} field ${fieldIndex} name`,
      );
      if (fieldNames.has(field.name)) {
        throw new Error(
          `functional host capability ${JSON.stringify(declaration.name)} repeats field ${
            JSON.stringify(field.name)
          }`,
        );
      }
      fieldNames.add(field.name);
      if (field.kind === "value") {
        requireScalarType(
          field.type,
          `capability ${JSON.stringify(declaration.name)} value ${JSON.stringify(field.name)}`,
        );
        return Object.freeze({ ...field, type: Object.freeze({ ...field.type }) });
      }
      if (field.kind !== "operation") {
        const unsupported = field as { readonly kind?: unknown; readonly name?: unknown };
        throw new Error(
          `functional host capability ${JSON.stringify(declaration.name)} field ${
            JSON.stringify(unsupported.name)
          } has unsupported kind ${JSON.stringify(unsupported.kind)}`,
        );
      }
      if (field.purity !== "pure" && field.purity !== "effectful") {
        throw new Error(
          `functional host operation ${
            JSON.stringify(`${declaration.name}.${field.name}`)
          } has unsupported purity ${JSON.stringify(field.purity)}`,
        );
      }
      requireScalarType(
        field.parameter,
        `operation ${JSON.stringify(`${declaration.name}.${field.name}`)} parameter`,
      );
      requireScalarType(
        field.result,
        `operation ${JSON.stringify(`${declaration.name}.${field.name}`)} result`,
      );
      return Object.freeze({
        ...field,
        parameter: Object.freeze({ ...field.parameter }),
        result: Object.freeze({ ...field.result }),
      });
    });
    return Object.freeze({ name: declaration.name, fields: Object.freeze(fields) });
  }));
}

export function functionalHostFieldType(
  field: FunctionalHostFieldDeclaration,
): FunctionalTypeSchema {
  if (field.kind === "value") return field.type;
  return {
    kind: "function",
    parameter: field.parameter,
    result: field.result,
  };
}

function requireName(name: string, location: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `functional host ${location} must be nonempty; received ${JSON.stringify(name)}`,
    );
  }
}

function requireScalarType(type: FunctionalHostScalarType, location: string): void {
  if (type?.kind === "integer" || type?.kind === "boolean" || type?.kind === "unit") return;
  throw new Error(
    `functional host ${location} must be integer, boolean, or unit; received ${
      JSON.stringify(type)
    }`,
  );
}
