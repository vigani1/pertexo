import {
  schemaFields as readSchemaFields,
  type SchemaFieldSpec,
} from '@/lib/schema-fields/fields';
export type { SchemaFieldSpec } from '@/lib/schema-fields/fields';
import { isJsonObject } from '@pertexo/workflow-model';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { describeAmount, toStoredValue } from '@/lib/schema-fields/units';

type WorkflowNode = WorkflowGraphContract['nodes'][number];
export type NodeConfig = WorkflowNode['config'];

export function schemaFields(schema: unknown): readonly SchemaFieldSpec[] {
  return readSchemaFields(schema, { jsonObjects: true });
}

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

/** How many of a schema's own properties the fields draw. */
export function coveredProperties(fields: readonly SchemaFieldSpec[]): number {
  return new Set(fields.map((field) => field.parent?.key ?? field.key)).size;
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

export function parseConfigJson(
  text: string,
  label = 'The setup',
): FieldParseResult<NodeConfig> {
  const parsed = parseJson(text);
  if (parsed === undefined)
    return {
      ok: false,
      error: 'That isn’t valid JSON yet. Check for a missing quote or brace.',
    };
  if (!isJsonObject(parsed))
    return {
      ok: false,
      error: `${label} must be a JSON object, like {"name": "value"}.`,
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
