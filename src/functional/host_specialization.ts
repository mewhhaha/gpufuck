import type { FunctionalType, FunctionalTypeSchema } from "./abi.ts";
import type { FunctionalHostOperationDeclaration, FunctionalHostType } from "./host_contract.ts";
import type { FunctionalRuntimeTypeDescriptor } from "./wasm_contract.ts";

const MAXIMUM_RUNTIME_TYPE_DEPTH = 64;
const MAXIMUM_RUNTIME_TYPE_NODES = 4_096;

interface RuntimeTypeTraversal {
  readonly activeTypes: WeakSet<object>;
  remainingNodes: number;
}

export function specializeFunctionalHostOperation(
  operation: FunctionalHostOperationDeclaration,
  substitutions: Readonly<Record<string, FunctionalHostType>>,
): FunctionalHostOperationDeclaration {
  if (operation === null || typeof operation !== "object") {
    throw new TypeError(
      `functional host specialization operation must be an object; received ${
        JSON.stringify(operation)
      }`,
    );
  }
  if (typeof operation.name !== "string" || operation.name.length === 0) {
    throw new TypeError(
      `functional host specialization operation name must be nonempty; received ${
        JSON.stringify(operation.name)
      }`,
    );
  }
  if (substitutions === null || typeof substitutions !== "object") {
    throw new TypeError(
      `functional host operation ${JSON.stringify(operation.name)} substitutions must be an object`,
    );
  }
  const parameters = operation.typeParameters ?? [];
  if (!Array.isArray(parameters)) {
    throw new TypeError(
      `functional host operation ${JSON.stringify(operation.name)} typeParameters must be an array`,
    );
  }
  for (const [index, parameter] of parameters.entries()) {
    if (typeof parameter !== "string" || parameter.length === 0) {
      throw new TypeError(
        `functional host operation ${
          JSON.stringify(operation.name)
        } type parameter ${index} must be nonempty; received ${JSON.stringify(parameter)}`,
      );
    }
  }
  const expected = new Set(parameters);
  if (expected.size !== parameters.length) {
    throw new Error(
      `functional host operation ${JSON.stringify(operation.name)} repeats a type parameter in ${
        JSON.stringify(parameters)
      }`,
    );
  }
  for (const parameter of parameters) {
    if (!Object.hasOwn(substitutions, parameter)) {
      throw new Error(
        `functional host operation ${JSON.stringify(operation.name)} specialization omits ${
          JSON.stringify(parameter)
        }`,
      );
    }
  }
  for (const parameter of Object.keys(substitutions)) {
    if (!expected.has(parameter)) {
      throw new Error(
        `functional host operation ${
          JSON.stringify(operation.name)
        } specialization supplies unknown ${JSON.stringify(parameter)}`,
      );
    }
  }
  const specialization = parameters.map((parameter) => {
    const descriptor = functionalRuntimeTypeDescriptor(substitutions[parameter]!);
    return `${encodeURIComponent(parameter)}=${
      encodeURIComponent(
        functionalRuntimeTypeDescriptorKey(descriptor),
      )
    }`;
  }).join("&");
  return Object.freeze({
    ...operation,
    name: specialization.length === 0 ? operation.name : `${operation.name}@${specialization}`,
    typeParameters: Object.freeze([]),
    parameter: substituteType(operation.parameter, substitutions),
    result: substituteType(operation.result, substitutions),
    ...(operation.parameterRepresentation === undefined ? {} : {
      parameterRepresentation: substituteType(
        operation.parameterRepresentation,
        substitutions,
      ),
    }),
    ...(operation.resultRepresentation === undefined ? {} : {
      resultRepresentation: substituteType(operation.resultRepresentation, substitutions),
    }),
  });
}

export function functionalRuntimeTypeDescriptor(
  schema: FunctionalTypeSchema,
  substitutions: Readonly<Record<string, FunctionalHostType>> = {},
): FunctionalRuntimeTypeDescriptor {
  const type = substituteType(schema, substitutions);
  requireRuntimeType(type, "$", 0, runtimeTypeTraversal());
  return type as FunctionalType;
}

export function functionalRuntimeTypeDescriptorKey(
  descriptor: FunctionalRuntimeTypeDescriptor,
): string {
  requireRuntimeType(descriptor, "$", 0, runtimeTypeTraversal());
  return JSON.stringify(runtimeTypeKeyValue(descriptor));
}

function substituteType(
  schema: FunctionalTypeSchema,
  substitutions: Readonly<Record<string, FunctionalHostType>>,
  path = "$",
  depth = 0,
  traversal: RuntimeTypeTraversal = runtimeTypeTraversal(),
): FunctionalHostType {
  if (depth > MAXIMUM_RUNTIME_TYPE_DEPTH) {
    throw new RangeError(
      `functional type schema exceeds depth ${MAXIMUM_RUNTIME_TYPE_DEPTH} at ${path}`,
    );
  }
  consumeRuntimeTypeNode(traversal, "functional type schema", path);
  if (schema === null || typeof schema !== "object" || typeof schema.kind !== "string") {
    throw new TypeError(`functional type schema is malformed at ${path}`);
  }
  if (traversal.activeTypes.has(schema)) {
    throw new TypeError(`functional type schema contains a structural cycle at ${path}`);
  }
  traversal.activeTypes.add(schema);
  try {
    switch (schema.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return { kind: schema.kind };
      case "parameter": {
        if (typeof schema.name !== "string" || schema.name.length === 0) {
          throw new TypeError(`functional type parameter needs a name at ${path}`);
        }
        const replacement = substitutions[schema.name];
        if (replacement === undefined) {
          throw new Error(
            `functional runtime type specialization leaves parameter ${
              JSON.stringify(schema.name)
            }`,
          );
        }
        return replacement;
      }
      case "tuple":
        if (!Array.isArray(schema.values) || schema.values.length !== 2) {
          throw new TypeError(`functional tuple type schema needs two values at ${path}`);
        }
        return {
          kind: "tuple",
          values: [
            substituteType(schema.values[0], substitutions, `${path}.0`, depth + 1, traversal),
            substituteType(schema.values[1], substitutions, `${path}.1`, depth + 1, traversal),
          ],
        };
      case "named":
        if (typeof schema.name !== "string" || schema.name.length === 0) {
          throw new TypeError(`functional named type schema needs a name at ${path}`);
        }
        if (!Array.isArray(schema.arguments)) {
          throw new TypeError(`functional named type schema needs arguments at ${path}`);
        }
        return {
          kind: "named",
          name: schema.name,
          arguments: schema.arguments.map((argument, index) =>
            substituteType(
              argument,
              substitutions,
              `${path}.arguments[${index}]`,
              depth + 1,
              traversal,
            )
          ),
        };
      case "function":
        return {
          kind: "function",
          parameter: substituteType(
            schema.parameter,
            substitutions,
            `${path}.parameter`,
            depth + 1,
            traversal,
          ),
          result: substituteType(
            schema.result,
            substitutions,
            `${path}.result`,
            depth + 1,
            traversal,
          ),
        };
      case "forall":
        throw new TypeError("functional runtime type descriptors cannot retain forall schemas");
      default:
        throw new TypeError(
          `functional type schema has unsupported kind ${
            JSON.stringify((schema as { readonly kind: unknown }).kind)
          } at ${path}`,
        );
    }
  } finally {
    traversal.activeTypes.delete(schema);
  }
}

function requireRuntimeType(
  type: FunctionalTypeSchema,
  path: string,
  depth: number,
  traversal: RuntimeTypeTraversal,
): void {
  if (depth > MAXIMUM_RUNTIME_TYPE_DEPTH) {
    throw new RangeError(
      `functional runtime type exceeds depth ${MAXIMUM_RUNTIME_TYPE_DEPTH} at ${path}`,
    );
  }
  consumeRuntimeTypeNode(traversal, "functional runtime type", path);
  if (type === null || typeof type !== "object" || typeof type.kind !== "string") {
    throw new TypeError(`functional runtime type is malformed at ${path}`);
  }
  if (traversal.activeTypes.has(type)) {
    throw new TypeError(`functional runtime type contains a structural cycle at ${path}`);
  }
  if (type.kind === "function") {
    throw new TypeError(`functional runtime type contains a function at ${path}`);
  }
  if (type.kind === "parameter" || type.kind === "forall") {
    throw new TypeError(`functional runtime type retains ${type.kind} at ${path}`);
  }
  if (type.kind === "tuple") {
    if (!Array.isArray(type.values) || type.values.length !== 2) {
      throw new TypeError(`functional runtime tuple type needs two values at ${path}`);
    }
    traversal.activeTypes.add(type);
    try {
      requireRuntimeType(type.values[0], `${path}.0`, depth + 1, traversal);
      requireRuntimeType(type.values[1], `${path}.1`, depth + 1, traversal);
    } finally {
      traversal.activeTypes.delete(type);
    }
    return;
  }
  if (type.kind === "named") {
    if (typeof type.name !== "string" || type.name.length === 0) {
      throw new TypeError(`functional runtime named type needs a name at ${path}`);
    }
    if (!Array.isArray(type.arguments)) {
      throw new TypeError(`functional runtime named type needs arguments at ${path}`);
    }
    traversal.activeTypes.add(type);
    try {
      for (const [index, argument] of type.arguments.entries()) {
        requireRuntimeType(argument, `${path}.arguments[${index}]`, depth + 1, traversal);
      }
    } finally {
      traversal.activeTypes.delete(type);
    }
    return;
  }
  if (
    type.kind === "integer" || type.kind === "signed-integer-64" || type.kind === "float-32" ||
    type.kind === "float-64" || type.kind === "boolean" || type.kind === "unit"
  ) return;
  throw new TypeError(
    `functional runtime type has unsupported kind ${
      JSON.stringify((type as { kind: unknown }).kind)
    } at ${path}`,
  );
}

function runtimeTypeTraversal(): RuntimeTypeTraversal {
  return {
    activeTypes: new WeakSet(),
    remainingNodes: MAXIMUM_RUNTIME_TYPE_NODES,
  };
}

function consumeRuntimeTypeNode(
  traversal: RuntimeTypeTraversal,
  description: string,
  path: string,
): void {
  if (traversal.remainingNodes === 0) {
    throw new RangeError(
      `${description} exceeds ${MAXIMUM_RUNTIME_TYPE_NODES} nodes at ${path}`,
    );
  }
  traversal.remainingNodes -= 1;
}

function runtimeTypeKeyValue(type: FunctionalRuntimeTypeDescriptor): unknown {
  switch (type.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return { kind: type.kind };
    case "tuple":
      return { kind: "tuple", values: type.values.map(runtimeTypeKeyValue) };
    case "named":
      return {
        kind: "named",
        name: type.name,
        arguments: type.arguments.map(runtimeTypeKeyValue),
      };
    case "function":
      throw new TypeError("functional runtime type descriptors cannot contain functions");
  }
}
