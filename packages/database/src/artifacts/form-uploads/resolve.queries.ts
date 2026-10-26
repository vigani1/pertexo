import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  attachFormFiles,
  formFileUploads,
  type FormField,
  type FormFileValue,
  type FormValues,
} from '@pertexo/workflow-model';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { artifacts } from '../../schema/transport.js';
import { formUploads } from '../../schema/triggers/forms.js';
import { boundUploadsSql, type FormUploadBinding } from './targets.queries.js';

/**
 * Swaps a response's upload IDs for file references. Only finalized, unexpired
 * uploads begun by the same response for the same field qualify.
 */
export async function resolveFormFiles(
  client: PoolClient,
  binding: FormUploadBinding & Readonly<{ session: string | undefined }>,
  fields: readonly FormField[],
  values: FormValues,
): Promise<FormValues> {
  const uploadIds = formFileUploads(fields, values).flatMap(
    (entry) => entry.uploadIds,
  );
  if (uploadIds.length === 0) return values;
  const found = new Map<string, FormFileValue>();
  if (binding.session !== undefined) {
    const rows = await drizzle(client)
      .select({
        fieldId: formUploads.fieldId,
        filename: formUploads.filename,
        artifactId: artifacts.id,
        byteLength: artifacts.byteLength,
        mediaType: artifacts.mediaType,
        sha256: artifacts.sha256,
      })
      .from(formUploads)
      .innerJoin(
        artifacts,
        and(
          eq(artifacts.workspaceId, formUploads.workspaceId),
          eq(artifacts.id, formUploads.artifactId),
        ),
      )
      .where(
        and(
          boundUploadsSql(binding, binding.session),
          inArray(formUploads.artifactId, uploadIds),
          eq(artifacts.purpose, 'form-upload'),
          eq(artifacts.status, 'available'),
          sql`${artifacts.expiresAt}>clock_timestamp()`,
        ),
      )
      .catch(rethrowQueryFailure);
    for (const row of rows)
      found.set(`${row.fieldId}:${row.artifactId}`, {
        file: {
          kind: 'artifact',
          artifactId: row.artifactId,
          byteLength: row.byteLength,
          mediaType: row.mediaType,
          sha256: row.sha256,
        },
        filename: row.filename,
      });
  }
  return attachFormFiles(fields, values, found);
}
