import type { TypeSchema } from "./abi.ts";
import type { SurfaceExpression, SurfaceTypeDeclaration } from "./surface_contract.ts";

export const HAS_FIELD_TYPE_NAME = "$FunctionalHasField";
export const EXTEND_RECORD_TYPE_NAME = "$FunctionalExtendRecord";

const EXTEND_RECORD_CONSTRUCTOR_NAME = "$FunctionalExtendRecordValue";

export interface StructuralRecordLayout {
  readonly type: string;
  readonly constructor: string;
  readonly fields: readonly string[];
}

export interface StructuralRecordSurfaceBuilder {
  name(name: string): SurfaceExpression;
  lambda(parameters: string | readonly string[], body: SurfaceExpression): SurfaceExpression;
  apply(
    callee: SurfaceExpression,
    ...arguments_: readonly SurfaceExpression[]
  ): SurfaceExpression;
  case(
    value: SurfaceExpression,
    arms: readonly {
      readonly constructor: string;
      readonly binders: readonly string[];
      readonly body: SurfaceExpression;
    }[],
  ): SurfaceExpression;
}

export interface StructuralRecordSurface {
  structuralRecord(
    layout: StructuralRecordLayout,
    fields: Readonly<Record<string, SurfaceExpression>>,
  ): SurfaceExpression;
  hasFieldEvidence(
    layout: StructuralRecordLayout,
    field: string,
  ): SurfaceExpression;
  projectField(
    field: string,
    record: SurfaceExpression,
    evidence: SurfaceExpression,
  ): SurfaceExpression;
  extendRecordEvidence(
    source: StructuralRecordLayout,
    patch: StructuralRecordLayout,
    result: StructuralRecordLayout,
  ): SurfaceExpression;
  extendRecord(
    record: SurfaceExpression,
    patch: SurfaceExpression,
    evidence: SurfaceExpression,
  ): SurfaceExpression;
}

export function createStructuralRecordSurface(
  surface: StructuralRecordSurfaceBuilder,
): StructuralRecordSurface {
  return {
    structuralRecord(layout, fields): SurfaceExpression {
      requireLayout(layout);
      const expected = new Set(layout.fields);
      for (const field of Object.keys(fields)) {
        if (!expected.has(field)) {
          throw new Error(
            `structural record ${JSON.stringify(layout.type)} has no field ${
              JSON.stringify(field)
            }`,
          );
        }
      }
      const values = layout.fields.map((field) => {
        const value = fields[field];
        if (value === undefined) {
          throw new Error(
            `structural record ${JSON.stringify(layout.type)} is missing field ${
              JSON.stringify(field)
            }`,
          );
        }
        return value;
      });
      return applyConstructor(surface, layout.constructor, values);
    },

    hasFieldEvidence(layout, field): SurfaceExpression {
      requireLayout(layout);
      const selected = layout.fields.indexOf(field);
      if (selected < 0) {
        throw new Error(
          `structural record ${JSON.stringify(layout.type)} has no field ${JSON.stringify(field)}`,
        );
      }
      const record = "$structuralRecord";
      const binders = layout.fields.map((name, index) => `$field${index}:${name}`);
      return surface.apply(
        surface.name(hasFieldConstructorName(field)),
        surface.lambda(
          record,
          surface.case(surface.name(record), [{
            constructor: layout.constructor,
            binders,
            body: surface.name(binders[selected]!),
          }]),
        ),
      );
    },

    projectField(field, record, evidence): SurfaceExpression {
      const accessor = `$project:${field}`;
      return surface.case(evidence, [{
        constructor: hasFieldConstructorName(field),
        binders: [accessor],
        body: surface.apply(surface.name(accessor), record),
      }]);
    },

    extendRecordEvidence(source, patch, result): SurfaceExpression {
      requireExtensionLayouts(source, patch, result);
      const sourceName = "$extendSource";
      const patchName = "$extendPatch";
      const sourceBinders = source.fields.map((field, index) => `$source${index}:${field}`);
      const patchBinders = patch.fields.map((field, index) => `$patch${index}:${field}`);
      const sourceValues = new Map(
        source.fields.map((field, index) => [field, surface.name(sourceBinders[index]!)]),
      );
      const patchValues = new Map(
        patch.fields.map((field, index) => [field, surface.name(patchBinders[index]!)]),
      );
      const values = result.fields.map((field) =>
        patchValues.get(field) ?? sourceValues.get(field)!
      );
      const extension = surface.lambda(
        [sourceName, patchName],
        surface.case(surface.name(sourceName), [{
          constructor: source.constructor,
          binders: sourceBinders,
          body: surface.case(surface.name(patchName), [{
            constructor: patch.constructor,
            binders: patchBinders,
            body: applyConstructor(surface, result.constructor, values),
          }]),
        }]),
      );
      return surface.apply(surface.name(EXTEND_RECORD_CONSTRUCTOR_NAME), extension);
    },

    extendRecord(record, patch, evidence): SurfaceExpression {
      const extension = "$extendRecord";
      return surface.case(evidence, [{
        constructor: EXTEND_RECORD_CONSTRUCTOR_NAME,
        binders: [extension],
        body: surface.apply(surface.name(extension), record, patch),
      }]);
    },
  };
}

export function hasFieldType(
  field: string,
  record: TypeSchema,
  value: TypeSchema,
): TypeSchema {
  return {
    kind: "named",
    name: HAS_FIELD_TYPE_NAME,
    arguments: [
      { kind: "named", name: fieldLabelTypeName(field), arguments: [] },
      record,
      value,
    ],
  };
}

export function extendRecordType(
  source: TypeSchema,
  patch: TypeSchema,
  result: TypeSchema,
): TypeSchema {
  return {
    kind: "named",
    name: EXTEND_RECORD_TYPE_NAME,
    arguments: [source, patch, result],
  };
}

/** Declares the closed evidence constructors for structural projection and extension. */
export function structuralRecordTypeDeclarations(
  fields: readonly string[],
): readonly SurfaceTypeDeclaration[] {
  const labels = [...new Set(fields)].sort();
  return [
    ...labels.map((field): SurfaceTypeDeclaration => ({
      name: fieldLabelTypeName(field),
      parameters: [],
      constructors: [],
    })),
    {
      name: HAS_FIELD_TYPE_NAME,
      parameters: ["label", "record", "value"],
      constructors: labels.map((field) => ({
        name: hasFieldConstructorName(field),
        fields: [{
          name: "accessor",
          type: {
            kind: "function",
            parameter: { kind: "parameter", name: "record" },
            result: { kind: "parameter", name: "value" },
          },
        }],
        result: hasFieldType(
          field,
          { kind: "parameter", name: "record" },
          { kind: "parameter", name: "value" },
        ),
      })),
    },
    {
      name: EXTEND_RECORD_TYPE_NAME,
      parameters: ["source", "patch", "result"],
      constructors: [{
        name: EXTEND_RECORD_CONSTRUCTOR_NAME,
        fields: [{
          name: "extension",
          type: {
            kind: "function",
            parameter: { kind: "parameter", name: "source" },
            result: {
              kind: "function",
              parameter: { kind: "parameter", name: "patch" },
              result: { kind: "parameter", name: "result" },
            },
          },
        }],
      }],
    },
  ];
}

function requireLayout(layout: StructuralRecordLayout): void {
  if (layout.type.length === 0 || layout.constructor.length === 0) {
    throw new Error("structural record layout names must not be empty");
  }
  const fields = new Set<string>();
  for (const field of layout.fields) {
    if (field.length === 0) throw new Error(`structural record ${layout.type} has an empty field`);
    if (fields.has(field)) {
      throw new Error(
        `structural record ${JSON.stringify(layout.type)} repeats field ${JSON.stringify(field)}`,
      );
    }
    fields.add(field);
  }
}

function requireExtensionLayouts(
  source: StructuralRecordLayout,
  patch: StructuralRecordLayout,
  result: StructuralRecordLayout,
): void {
  requireLayout(source);
  requireLayout(patch);
  requireLayout(result);
  const expected = new Set([...source.fields, ...patch.fields]);
  const actual = new Set(result.fields);
  for (const field of expected) {
    if (!actual.has(field)) {
      throw new Error(
        `structural record extension result ${JSON.stringify(result.type)} is missing field ${
          JSON.stringify(field)
        }`,
      );
    }
  }
  for (const field of actual) {
    if (!expected.has(field)) {
      throw new Error(
        `structural record extension result ${JSON.stringify(result.type)} adds unknown field ${
          JSON.stringify(field)
        }`,
      );
    }
  }
}

function applyConstructor(
  surface: StructuralRecordSurfaceBuilder,
  constructor: string,
  values: readonly SurfaceExpression[],
): SurfaceExpression {
  const reference = surface.name(constructor);
  return values.length === 0 ? reference : surface.apply(reference, ...values);
}

function fieldLabelTypeName(field: string): string {
  return `$FunctionalFieldLabel:${encodeURIComponent(field)}`;
}

function hasFieldConstructorName(field: string): string {
  return `$FunctionalHasField:${encodeURIComponent(field)}`;
}
