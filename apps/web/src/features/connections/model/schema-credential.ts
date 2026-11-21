import {
  emailMailboxSchema,
  signingKeyCredentialSchema,
  type ParsedConnectionCredential,
} from '@pertexo/contracts';
import type { ConnectionFormDefinition } from '@pertexo/contracts';
import { fromJSONSchema } from 'zod';
import { isRecord } from '@pertexo/workflow-model';
import { schemaFields } from '@/lib/schema-fields/fields';

export type ScalarValue = string | boolean;
export type SchemaCredentialDraft = Readonly<{
  provider: 'schema';
  definition: ConnectionFormDefinition;
  values: Readonly<Record<string, ScalarValue>>;
}>;

export function credentialFields(definition: ConnectionFormDefinition) {
  const { properties } = definition.fields;
  return schemaFields(definition.fields).flatMap((field) => {
    if (!isRecord(properties)) return [];
    const metadata = properties[field.key];
    return isRecord(metadata) ? [{ ...field, metadata }] : [];
  });
}

export function emptySchemaCredential(
  definition: ConnectionFormDefinition,
): SchemaCredentialDraft {
  const values = Object.fromEntries<ScalarValue>(
    credentialFields(definition).map(
      ({ key, kind, metadata }): [string, ScalarValue] => {
        const value = metadata.default;
        if (kind === 'boolean') return [key, value === true];
        if (typeof value === 'string' || typeof value === 'number')
          return [key, String(value)];
        return [key, ''];
      },
    ),
  );
  return { provider: 'schema', definition, values };
}

export function isVisibleField(
  metadata: Readonly<Record<string, unknown>>,
  values: SchemaCredentialDraft['values'],
) {
  const { visibleWhen } = metadata;
  return (
    !isRecord(visibleWhen) ||
    (typeof visibleWhen.field === 'string' &&
      values[visibleWhen.field] === visibleWhen.value)
  );
}

export function isRequiredField(
  field: ReturnType<typeof credentialFields>[number],
  values: SchemaCredentialDraft['values'],
) {
  const when = field.metadata.requiredWhen;
  if (field.required) return true;
  if (
    !isRecord(when) ||
    typeof when.field !== 'string' ||
    !Array.isArray(when.values)
  )
    return false;
  const choice = values[when.field];
  return when.values.some((value) => value === choice);
}

const signingKeyField = signingKeyCredentialSchema.unwrap().shape.signingKey;

export function parseScalarCredential(draft: SchemaCredentialDraft) {
  const fields: Record<string, ScalarValue | number> = {};
  const errors: Record<string, string> = {};
  for (const field of credentialFields(draft.definition)) {
    const { key, kind, metadata } = field;
    const required = isRequiredField(field, draft.values);
    if (!isVisibleField(metadata, draft.values)) continue;
    const raw = draft.values[key];
    if (raw === undefined && !required) continue;
    const trimmed =
      metadata.trim === true && typeof raw === 'string' ? raw.trim() : raw;
    if (metadata.omitEmpty === true && String(trimmed ?? '').trim() === '') {
      if (required) errors[key] = `${field.label} is required.`;
      continue;
    }
    const value =
      kind === 'number' || kind === 'integer' ? Number(trimmed) : trimmed;
    const schema = credentialFieldSchema(metadata);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      errors[key] = parsed.error.issues[0]?.message ?? 'Check this value.';
      continue;
    }
    if (metadata.validateAs === 'mailbox' && typeof parsed.data === 'string')
      fields[key] = parsed.data;
    else if (value !== undefined) fields[key] = value;
  }
  const credential: ParsedConnectionCredential = {
    ...fields,
    type: draft.definition.authType,
  };
  return { errors, credential };
}

function credentialFieldSchema(
  metadata: Parameters<typeof fromJSONSchema>[0] &
    Readonly<Record<string, unknown>>,
) {
  if (metadata.validateAs === 'mailbox') return emailMailboxSchema;
  if (metadata.validateAs === 'utf8_key') return signingKeyField;
  return fromJSONSchema(metadata);
}
