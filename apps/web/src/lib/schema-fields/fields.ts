import { fieldLabel, fieldUnit, type FieldUnit } from './units';

export type SchemaFieldSpec = Readonly<{
  key: string;
  label: string;
  kind: 'boolean' | 'integer' | 'number' | 'string' | 'json-object';
  required: boolean;
  description?: string;
  options?: readonly string[];
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
    const field = schemaField(key, candidate, required, options?.jsonObjects);
    if (field !== undefined) return [field];
    const nested = objectFields(candidate);
    const parent = { key, label: titleOf(candidate) ?? fieldLabel(key) };
    const children = nested.flatMap((child) => {
      const childField = schemaField(
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

function schemaField(
  key: string,
  candidate: unknown,
  required: boolean,
  jsonObjects = false,
): SchemaFieldSpec | undefined {
  if (!isSchemaObject(candidate)) return undefined;
  const {
    type,
    title,
    description,
    minimum,
    maximum,
    format,
    contentMediaType,
  } = candidate;
  if (type === 'object' && jsonObjects && objectFields(candidate).length === 0)
    return {
      key,
      label: typeof title === 'string' ? title : fieldLabel(key),
      kind: 'json-object',
      required,
      ...(typeof description === 'string' ? { description } : {}),
    };
  if (
    type !== 'string' &&
    type !== 'number' &&
    type !== 'integer' &&
    type !== 'boolean'
  )
    return undefined;
  const unit =
    type === 'string' || type === 'boolean' ? undefined : fieldUnit(key);
  const choices = type === 'string' ? stringChoices(candidate) : undefined;
  return {
    key,
    label: typeof title === 'string' ? title : fieldLabel(key),
    kind: type,
    required,
    ...(typeof description === 'string' ? { description } : {}),
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

/**
 * A string's choices: its `enum`, each named by the matching `oneOf`
 * `{ const, title }` when the schema labels them.
 */
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
