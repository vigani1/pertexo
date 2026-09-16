import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';

type WorkflowNode = WorkflowGraphContract['nodes'][number];
export type NodeConfig = WorkflowNode['config'];

export type SchemaFieldSpec = Readonly<{
  key: string;
  label: string;
  kind: 'boolean' | 'integer' | 'number' | 'string';
  required: boolean;
  options?: readonly string[];
}>;

export type NumericConfigResult =
  | Readonly<{ config: NodeConfig; errors: Readonly<Record<string, never>> }>
  | Readonly<{
      config?: never;
      errors: Readonly<Record<string, string>>;
    }>;

export function persistedNodeState(node: WorkflowNode): string {
  return JSON.stringify({
    label: node.label ?? '',
    config: node.config,
    connectionRefs: node.connectionRefs,
  });
}

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
    const optionValue = Reflect.get(candidate, 'enum');
    const options =
      type === 'string' &&
      Array.isArray(optionValue) &&
      optionValue.every((option) => typeof option === 'string')
        ? optionValue
        : undefined;
    return [
      {
        key,
        label: typeof title === 'string' ? title : key,
        kind: type,
        required: required.has(key),
        ...(options === undefined ? {} : { options }),
      } satisfies SchemaFieldSpec,
    ];
  });
}

export function numericScratchFor(
  config: NodeConfig,
  fields: readonly SchemaFieldSpec[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    fields.flatMap((field) => {
      if (field.kind !== 'number' && field.kind !== 'integer') return [];
      const value = config[field.key];
      return [[field.key, typeof value === 'number' ? String(value) : '']];
    }),
  );
}

export function ordinaryFieldScratchFor(
  config: NodeConfig,
  fields: readonly SchemaFieldSpec[],
): Readonly<Record<string, NodeConfig[string] | undefined>> {
  return Object.fromEntries(
    fields.flatMap((field) =>
      field.kind === 'number' || field.kind === 'integer'
        ? []
        : [[field.key, config[field.key]]],
    ),
  );
}

export function applyOrdinaryFieldScratch(
  config: NodeConfig,
  scratch: Readonly<Record<string, NodeConfig[string] | undefined>>,
  scratchOwnedFields: ReadonlySet<string>,
): NodeConfig {
  let next = { ...config };
  for (const fieldKey of scratchOwnedFields) {
    const value = scratch[fieldKey];
    if (value === undefined)
      next = Object.fromEntries(
        Object.entries(next).filter(([key]) => key !== fieldKey),
      );
    else next[fieldKey] = value;
  }
  return next;
}

export function applyNumericScratch(
  config: NodeConfig,
  fields: readonly SchemaFieldSpec[],
  scratch: Readonly<Record<string, string>>,
  scratchOwnedFields?: ReadonlySet<string>,
): NumericConfigResult {
  let next = { ...config };
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind !== 'number' && field.kind !== 'integer') continue;
    if (
      scratchOwnedFields !== undefined &&
      !scratchOwnedFields.has(field.key)
    ) {
      const present = Object.prototype.hasOwnProperty.call(config, field.key);
      const value = config[field.key];
      if (!present) {
        if (field.required) errors[field.key] = `${field.label} is required.`;
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors[field.key] = `${field.label} must be a valid number.`;
        continue;
      }
      if (field.kind === 'integer' && !Number.isInteger(value))
        errors[field.key] = `${field.label} must be a whole number.`;
      continue;
    }
    const text = scratch[field.key] ?? '';
    if (text.trim() === '') {
      if (field.required) errors[field.key] = `${field.label} is required.`;
      else
        next = Object.fromEntries(
          Object.entries(next).filter(([key]) => key !== field.key),
        );
      continue;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      errors[field.key] = `${field.label} must be a valid number.`;
      continue;
    }
    if (field.kind === 'integer' && !Number.isInteger(value)) {
      errors[field.key] = `${field.label} must be a whole number.`;
      continue;
    }
    next[field.key] = value;
  }
  return Object.keys(errors).length === 0
    ? { config: next, errors: {} }
    : { errors };
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function isJsonObject(value: unknown): value is NodeConfig {
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
