import { isRecord } from '@pertexo/workflow-model';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  describeAmount,
  fieldLabel,
  fieldUnit,
  toStoredValue,
  type FieldUnit,
} from '../field-units';

type WorkflowNode = WorkflowGraphContract['nodes'][number];
export type NodeConfig = WorkflowNode['config'];

export type SchemaFieldSpec = Readonly<{
  key: string;
  label: string;
  kind: 'boolean' | 'integer' | 'number' | 'string';
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
  /** The object property this field sits in, one level down. */
  parent?: Readonly<{ key: string; label: string }>;
}>;

/**
 * How many settings a catalog JSON Schema declares, including each shape a
 * step's setup can take (Date and Read file choose an operation or format).
 */
export function schemaPropertyCount(schema: unknown): number {
  if (typeof schema !== 'object' || schema === null) return 0;
  const properties: unknown = Reflect.get(schema, 'properties');
  const own =
    typeof properties === 'object' && properties !== null
      ? Object.keys(properties).length
      : 0;
  const shapes = ['oneOf', 'anyOf'].flatMap((key) => {
    const value: unknown = Reflect.get(schema, key);
    return Array.isArray(value) ? (value as unknown[]) : [];
  });
  return shapes.reduce<number>(
    (count, shape) => count + schemaPropertyCount(shape),
    own,
  );
}

/** A typed value ready for the graph, or a sentence saying what's wrong. */
export type FieldParseResult<Value> =
  Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: string }>;

/**
 * The supported subset of a catalog JSON Schema: primitive and enum
 * properties, with their titles, descriptions and labelled choices, and
 * the same inside one level of nested object. Everything else stays
 * reachable through "Edit as JSON".
 */
export function schemaFields(schema: unknown): readonly SchemaFieldSpec[] {
  return objectFields(schema).flatMap(({ key, candidate, required }) => {
    const field = scalarField(key, candidate, required);
    if (field !== undefined) return [field];
    const nested = objectFields(candidate);
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

/** How many of a schema's own properties the fields draw. */
export function coveredProperties(fields: readonly SchemaFieldSpec[]): number {
  return new Set(fields.map((field) => field.parent?.key ?? field.key)).size;
}

/** The schema's own starting values: each property's `default`. */
export function propertyDefaults(schema: unknown): NodeConfig {
  const properties = isRecord(schema) ? schema.properties : undefined;
  if (!isRecord(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, candidate]) =>
      isRecord(candidate) &&
      'default' in candidate &&
      isJsonValue(candidate.default)
        ? [[key, structuredClone(candidate.default) as NodeConfig[string]]]
        : [],
    ),
  );
}

function titleOf(schema: unknown): string | undefined {
  return isRecord(schema) && typeof schema.title === 'string'
    ? schema.title
    : undefined;
}

type ObjectProperty = Readonly<{
  key: string;
  candidate: unknown;
  required: boolean;
}>;

function objectFields(schema: unknown): readonly ObjectProperty[] {
  if (!isRecord(schema) || schema.type !== 'object') return [];
  const { properties, required } = schema;
  if (!isRecord(properties)) return [];
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
  if (!isRecord(candidate)) return undefined;
  const { type, title, description, minimum, maximum, format } = candidate;
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
          isRecord(entry) &&
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

/**
 * Parses number text, typed in the field's shown unit (seconds for a
 * millisecond setting). An empty optional field removes the property
 * (`value: undefined`); partial text such as "-" or "1.5" for an integer is
 * reported rather than silently coerced. Bounds read in the shown unit.
 */
export function parseNumberField(
  field: SchemaFieldSpec,
  text: string,
): FieldParseResult<number | undefined> {
  if (text.trim() === '')
    return field.required
      ? { ok: false, error: `${field.label} is required.` }
      : { ok: true, value: undefined };
  const shown = Number(text);
  if (!Number.isFinite(shown))
    return { ok: false, error: `${field.label} must be a number.` };
  const value = toStoredValue(shown, field.unit, field.maximum);
  if (field.kind === 'integer' && !Number.isInteger(value))
    return {
      ok: false,
      error:
        field.unit === 'milliseconds'
          ? `${field.label} can have at most 3 decimals.`
          : `${field.label} must be a whole number.`,
    };
  if (field.minimum !== undefined && value < field.minimum)
    return {
      ok: false,
      error: `${field.label} must be at least ${describeAmount(field.minimum, field.unit)}.`,
    };
  if (field.maximum !== undefined && value > field.maximum)
    return {
      ok: false,
      error: `${field.label} can be at most ${describeAmount(field.maximum, field.unit)}.`,
    };
  return { ok: true, value };
}

export function parseConfigJson(text: string): FieldParseResult<NodeConfig> {
  const parsed = parseJson(text);
  if (parsed === undefined)
    return {
      ok: false,
      error: 'That isn’t valid JSON yet. Check for a missing quote or brace.',
    };
  if (!isJsonObject(parsed))
    return {
      ok: false,
      error: 'The setup must be a JSON object, like {"name": "value"}.',
    };
  return { ok: true, value: parsed };
}

/** Where a field's value sits: `key`, or `parent.key` one level down. */
export function fieldPath(field: Pick<SchemaFieldSpec, 'key' | 'parent'>) {
  return field.parent === undefined
    ? field.key
    : `${field.parent.key}.${field.key}`;
}

export function readFieldValue(
  config: NodeConfig,
  field: Pick<SchemaFieldSpec, 'key' | 'parent'>,
): NodeConfig[string] | undefined {
  if (field.parent === undefined) return config[field.key];
  const parent = config[field.parent.key];
  return isJsonObject(parent) ? parent[field.key] : undefined;
}

/**
 * Sets or removes a field's value. A nested object that loses its last
 * value goes too, so clearing an optional group leaves no empty object.
 */
export function withFieldValue(
  config: NodeConfig,
  field: Pick<SchemaFieldSpec, 'key' | 'parent'>,
  value: NodeConfig[string] | undefined,
): NodeConfig {
  if (field.parent === undefined)
    return withConfigValue(config, field.key, value);
  const current = config[field.parent.key];
  const parent = withConfigValue(
    isJsonObject(current) ? current : {},
    field.key,
    value,
  );
  return withConfigValue(
    config,
    field.parent.key,
    Object.keys(parent).length === 0 ? undefined : parent,
  );
}

/** Sets or removes one property without disturbing the others. */
export function withConfigValue(
  config: NodeConfig,
  key: string,
  value: NodeConfig[string] | undefined,
): NodeConfig {
  if (value !== undefined) return { ...config, [key]: value };
  return Object.fromEntries(
    Object.entries(config).filter(([entryKey]) => entryKey !== key),
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is NodeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
