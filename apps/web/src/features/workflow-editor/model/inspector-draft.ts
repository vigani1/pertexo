import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';

type WorkflowNode = WorkflowGraphContract['nodes'][number];
export type NodeConfig = WorkflowNode['config'];

export type SchemaFieldSpec = Readonly<{
  key: string;
  label: string;
  kind: 'boolean' | 'integer' | 'number' | 'string';
  required: boolean;
  description?: string;
  options?: readonly string[];
  minimum?: number;
  maximum?: number;
}>;

/** A typed value ready for the graph, or a sentence saying what's wrong. */
export type FieldParseResult<Value> =
  Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: string }>;

/**
 * The supported subset of a catalog JSON Schema: top-level primitive and
 * enum properties. Everything else stays reachable through "Edit as JSON".
 */
export function schemaFields(schema: unknown): readonly SchemaFieldSpec[] {
  if (!isRecord(schema) || Reflect.get(schema, 'type') !== 'object') return [];
  const properties = Reflect.get(schema, 'properties');
  if (!isRecord(properties)) return [];
  const requiredValue = Reflect.get(schema, 'required');
  const required = new Set(
    Array.isArray(requiredValue)
      ? requiredValue.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  );
  return Object.entries(properties).flatMap(([key, candidate]) => {
    if (!isRecord(candidate)) return [];
    const type = Reflect.get(candidate, 'type');
    if (
      type !== 'string' &&
      type !== 'number' &&
      type !== 'integer' &&
      type !== 'boolean'
    )
      return [];
    const title = Reflect.get(candidate, 'title');
    const description = Reflect.get(candidate, 'description');
    const optionValue = Reflect.get(candidate, 'enum');
    const minimum = Reflect.get(candidate, 'minimum');
    const maximum = Reflect.get(candidate, 'maximum');
    const options =
      type === 'string' &&
      Array.isArray(optionValue) &&
      optionValue.every((option) => typeof option === 'string')
        ? optionValue
        : undefined;
    return [
      {
        key,
        label: typeof title === 'string' ? title : humanizeKey(key),
        kind: type,
        required: required.has(key),
        ...(typeof description === 'string' ? { description } : {}),
        ...(options === undefined ? {} : { options }),
        ...(typeof minimum === 'number' ? { minimum } : {}),
        ...(typeof maximum === 'number' ? { maximum } : {}),
      } satisfies SchemaFieldSpec,
    ];
  });
}

/** `timeoutMillis` → "Timeout millis", `max_items` → "Max items". */
function humanizeKey(key: string): string {
  const words = key
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll(/[_-]+/gu, ' ')
    .trim()
    .toLowerCase();
  return words === ''
    ? key
    : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * Parses number text. An empty optional field removes the property
 * (`value: undefined`); partial text such as "-" or "1.5" for an integer is
 * reported rather than silently coerced.
 */
export function parseNumberField(
  field: SchemaFieldSpec,
  text: string,
): FieldParseResult<number | undefined> {
  if (text.trim() === '')
    return field.required
      ? { ok: false, error: `${field.label} is required.` }
      : { ok: true, value: undefined };
  const value = Number(text);
  if (!Number.isFinite(value))
    return { ok: false, error: `${field.label} must be a number.` };
  if (field.kind === 'integer' && !Number.isInteger(value))
    return { ok: false, error: `${field.label} must be a whole number.` };
  if (field.minimum !== undefined && value < field.minimum)
    return {
      ok: false,
      error: `${field.label} must be at least ${String(field.minimum)}.`,
    };
  if (field.maximum !== undefined && value > field.maximum)
    return {
      ok: false,
      error: `${field.label} can be at most ${String(field.maximum)}.`,
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
