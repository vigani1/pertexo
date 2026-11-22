import {
  CONNECTION_LOOKUP_FIELD,
  connectionLookupFieldSchema,
  type ConnectionLookupField,
} from '@pertexo/contracts';
import { fieldLabel, fieldUnit, type FieldUnit } from './units';

export type SchemaFieldSpec = Readonly<{
  key: string;
  label: string;
  kind: 'boolean' | 'integer' | 'number' | 'string' | 'json-object';
  required: boolean;
  description?: string;
  options?: readonly string[];
  lookup?: ConnectionLookupField;
  /** How each option reads, when the stored value is an ID. */
  optionLabels?: Readonly<Record<string, string>>;
  minimum?: number;
  maximum?: number;
  /** A number stored in this unit, which the field shows in people's terms. */
  unit?: FieldUnit;
  /** Text stored as an item path, typed as a field name. */
  format?: 'json-path';
  multiline?: true;
  /** The object property this field sits in, one level down. */
  parent?: Readonly<{ key: string; label: string }>;
}>;

/**
 * The supported subset of a catalog JSON Schema: primitive and enum
 * properties, with their titles, descriptions and labelled choices, and
 * the same inside one level of nested object. Open objects can be drawn
 * as JSON fields. Everything else stays
 * reachable through "Edit as JSON".
 */
export function schemaFields(
  schema: unknown,
  options?: Readonly<{ jsonObjects: boolean }>,
): readonly SchemaFieldSpec[] {
  return objectFields(schema).flatMap(({ key, candidate, required }) => {
    const field = scalarField(key, candidate, required);
    if (field !== undefined) return [field];
    const nested = objectFields(candidate);
    if (
      options?.jsonObjects === true &&
      nested.length === 0 &&
      isSchemaObject(candidate) &&
      candidate.type === 'object'
    )
      return [
        { ...fieldPresentation(key, candidate), kind: 'json-object', required },
      ];
    const parent = { key, label: titleOf(candidate) ?? fieldLabel(key) };
    const children = nested.flatMap((child) => {
      const childField = scalarField(
        child.key,
        child.candidate,
        required && child.required,
      );
      return childField === undefined ? [] : [{ ...childField, parent }];
    });
    // An object shown only in part would hide settings, so it stays on JSON.
    return nested.length > 0 && children.length === nested.length
      ? children
      : [];
  });
}

function titleOf(schema: unknown): string | undefined {
  return isSchemaObject(schema) && typeof schema.title === 'string'
    ? schema.title
    : undefined;
}

type ObjectProperty = Readonly<{
  key: string;
  candidate: unknown;
  required: boolean;
}>;

function objectFields(schema: unknown): readonly ObjectProperty[] {
  if (!isSchemaObject(schema) || schema.type !== 'object') return [];
  const { properties, required } = schema;
  if (!isSchemaObject(properties)) return [];
  const requiredKeys = new Set(
    Array.isArray(required)
      ? required.filter((value): value is string => typeof value === 'string')
      : [],
  );
  return Object.entries(properties).map(([key, candidate]) => ({
    key,
    candidate,
    required: requiredKeys.has(key),
  }));
}

function scalarField(
  key: string,
  candidate: unknown,
  required: boolean,
): SchemaFieldSpec | undefined {
  if (!isSchemaObject(candidate)) return undefined;
  const { type, minimum, maximum, format, contentMediaType } = candidate;
  if (
    type !== 'string' &&
    type !== 'number' &&
    type !== 'integer' &&
    type !== 'boolean'
  )
    return undefined;
  const unit =
    type === 'string' || type === 'boolean' ? undefined : fieldUnit(key);
  const choices = type === 'string' ? stringFieldOptions(candidate) : undefined;
  return {
    ...fieldPresentation(key, candidate),
    kind: type,
    required,
    ...(choices ?? {}),
    ...(typeof minimum === 'number' ? { minimum } : {}),
    ...(typeof maximum === 'number' ? { maximum } : {}),
    ...(unit === undefined ? {} : { unit }),
    ...(type === 'string' &&
    (contentMediaType === 'application/sql' ||
      contentMediaType === 'text/plain')
      ? { multiline: true as const }
      : {}),
    ...(type === 'string' && format === 'json-path'
      ? { format: 'json-path' as const }
      : {}),
  } satisfies SchemaFieldSpec;
}

function fieldPresentation(
  key: string,
  candidate: Readonly<Record<string, unknown>>,
): Pick<SchemaFieldSpec, 'key' | 'label' | 'description'> {
  const { description } = candidate;
  return {
    key,
    label: titleOf(candidate) ?? fieldLabel(key),
    ...(typeof description === 'string' ? { description } : {}),
  };
}

/**
 * A string's choices: its `enum`, each named by the matching `oneOf`
 * `{ const, title }` when the schema labels them.
 */
function stringFieldOptions(candidate: Readonly<Record<string, unknown>>) {
  const lookup = connectionLookupFieldSchema.safeParse(
    candidate[CONNECTION_LOOKUP_FIELD],
  );
  return lookup.success ? { lookup: lookup.data } : stringChoices(candidate);
}

function stringChoices(
  candidate: Readonly<Record<string, unknown>>,
): Pick<SchemaFieldSpec, 'options' | 'optionLabels'> | undefined {
  const { enum: values, oneOf } = candidate;
  if (
    !Array.isArray(values) ||
    !values.every((value) => typeof value === 'string')
  )
    return undefined;
  const labels = Array.isArray(oneOf)
    ? Object.fromEntries(
        oneOf.flatMap((entry: unknown) =>
          isSchemaObject(entry) &&
          typeof entry.const === 'string' &&
          typeof entry.title === 'string'
            ? [[entry.const, entry.title]]
            : [],
        ),
      )
    : {};
  return Object.keys(labels).length === 0
    ? { options: values }
    : { options: values, optionLabels: labels };
}

function isSchemaObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
