import { connectionCredentialSchema } from '@pertexo/contracts';
import type { ConnectionFormDefinition } from '@pertexo/contracts';
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

export function scalarCredentialInput(draft: SchemaCredentialDraft) {
  return {
    type: draft.definition.authType,
    ...Object.fromEntries(
      credentialFields(draft.definition).flatMap(({ key, kind, metadata }) => {
        if (!isVisibleField(metadata, draft.values)) return [];
        const raw = draft.values[key];
        const value =
          metadata.trim === true && typeof raw === 'string' ? raw.trim() : raw;
        if (metadata.omitEmpty === true && String(value ?? '').trim() === '')
          return [];
        return [
          [
            key,
            kind === 'number' || kind === 'integer' ? Number(value) : value,
          ],
        ];
      }),
    ),
  };
}

export function parseScalarCredential(draft: SchemaCredentialDraft) {
  return connectionCredentialSchema.safeParse(scalarCredentialInput(draft));
}
